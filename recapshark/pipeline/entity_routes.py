"""POST /api/entities — multilingual NER for transcript highlighting.

Single endpoint that:
  1. Looks up cached entities for `(video_id, lang)` in Supabase, keyed by
     a content hash so a different transcript text triggers re-extraction
     instead of trusting a stale cache.
  2. On cache miss, routes to spaCy (`ner.analyze`) for languages with an
     official model, or LLM (`ner_llm.analyze`) for everything else.
  3. Writes the result back to the cache so the next viewer of the same
     video in the same language is instant + free.

Returns a small JSON payload the frontend's entity-highlighter consumes
directly via `setEntities()`.

Hardening
---------
- **Rate limit:** per-IP token bucket, 10 calls/min. Defends against the
  obvious attack vector (someone scripting LLM calls to drain our budget).
- **Hallucination guard:** lives in `ner_llm.py`, not here — every entity
  is verified to appear verbatim in the source text before caching.
- **Hash-based cache key:** clients can't poison the cache by POSTing
  garbage transcript text for a real video — a different hash bypasses
  the cached entry. (Still trusts hash → entities mapping; full
  server-side translation cache is the proper fix, tracked as a follow-up.)
- **Kill switch:** `ENABLE_LLM_NER=false` disables LLM fallback. spaCy
  paths still work; unsupported langs return `{"entities": []}`.
- **Graceful failure:** every failure mode returns a valid empty result,
  never 5xx. Highlight pipeline must keep working when this is broken.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import time
from collections import deque
from threading import Lock
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import ner
import ner_llm
import supabase_owner_store as _supa


router = APIRouter()


# ── Rate limit ────────────────────────────────────────────────────────────
# Per-IP token bucket. Implemented as a sliding-window deque of timestamps
# rather than a real bucket because the volume is low (~few calls/min/user)
# and dependency-free is preferable to pulling in slowapi/limits for one
# endpoint. If we ever add more rate-limited endpoints, factor this out.
_RATE_LIMIT_PER_MIN = 10
_rate_buckets: dict[str, deque] = {}
_rate_lock = Lock()


def _check_rate_limit(ip: str) -> bool:
    """Returns True if the request should proceed, False if rate-limited."""
    now = time.time()
    cutoff = now - 60.0
    with _rate_lock:
        bucket = _rate_buckets.get(ip)
        if bucket is None:
            bucket = deque()
            _rate_buckets[ip] = bucket
        # Drop timestamps older than 60s.
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= _RATE_LIMIT_PER_MIN:
            return False
        bucket.append(now)
        return True


# ── Hash helper ───────────────────────────────────────────────────────────
# Whitespace-collapsed, lowercased SHA-256. Matches the same transcript
# regardless of trivial reformatting (trailing newline, double-space) so
# benign client variations don't blow up the cache hit rate.
def _transcript_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", (text or "").strip().lower())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ── Cache I/O ─────────────────────────────────────────────────────────────
# Direct REST calls via httpx so we don't pull in supabase-py just for two
# operations. Same pattern the rest of the project uses.

async def _cache_read(video_id: str, lang: str, t_hash: str) -> Optional[dict]:
    """Returns the cached row dict on hit (with matching hash), else None.

    A row exists with a different hash → treated as miss. The caller
    re-extracts and overwrites via UPSERT, which is the right behaviour
    when the underlying transcript actually changed (e.g. retranslation
    with a different model).
    """
    if not _supa.is_configured():
        return None
    url = (
        f"{_supa.supabase_url()}/rest/v1/rs_video_entities"
        f"?select=entities,source,transcript_hash,word_count,hallucinations_dropped"
        f"&video_id=eq.{video_id}"
        f"&lang=eq.{lang}"
    )
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            r = await http.get(url, headers=_supa.service_headers())
        if r.status_code != 200:
            print(f"[ENTITIES] cache read non-200 ({r.status_code}): {r.text[:200]}",
                  file=sys.stderr, flush=True)
            return None
        rows = r.json()
        if not rows:
            return None
        row = rows[0]
        if row.get("transcript_hash") != t_hash:
            return None  # hash mismatch → treat as miss
        return row
    except Exception as e:
        print(f"[ENTITIES] cache read failed: {e}", file=sys.stderr, flush=True)
        return None


async def _cache_write(video_id: str, lang: str, t_hash: str,
                       entities: list, source: str,
                       word_count: int, hallucinations_dropped: int) -> None:
    """UPSERT the result. Failures are logged but don't fail the request —
    the user gets their entities; the cache just wasn't written.
    """
    if not _supa.is_configured():
        return
    url = f"{_supa.supabase_url()}/rest/v1/rs_video_entities"
    headers = {
        **_supa.service_headers(),
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    body = {
        "video_id": video_id,
        "lang": lang,
        "transcript_hash": t_hash,
        "entities": entities,
        "source": source,
        "word_count": word_count,
        "hallucinations_dropped": hallucinations_dropped,
        "updated_at": "now()",
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            r = await http.post(url, headers=headers, json=body)
        if r.status_code not in (200, 201, 204):
            print(f"[ENTITIES] cache write non-2xx ({r.status_code}): {r.text[:200]}",
                  file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[ENTITIES] cache write failed: {e}", file=sys.stderr, flush=True)


# ── Extraction routing ────────────────────────────────────────────────────
def _normalize_lang(lang: str) -> str:
    """'fa-IR' -> 'fa'. Matches `ner.analyze` and `ner_llm.analyze` behaviour."""
    return (lang or "en").split("-")[0].lower()


def _has_spacy_model(lang: str) -> bool:
    """True iff our spaCy module has an official model registered for `lang`."""
    return _normalize_lang(lang) in ner._MODEL_BY_LANG


# ── Request/response models ───────────────────────────────────────────────
class EntitiesRequest(BaseModel):
    video_id: str = Field(..., min_length=1, max_length=64)
    lang: str = Field(..., min_length=1, max_length=16)
    transcript_text: str = Field(..., min_length=20)


class EntitiesResponse(BaseModel):
    entities: list[dict]
    source: str  # 'cache' | 'spacy' | 'llm' | 'unsupported'
    word_count: int
    hallucinations_dropped: int = 0


# ── Endpoint ──────────────────────────────────────────────────────────────
@router.post("/entities", response_model=EntitiesResponse)
async def get_entities(payload: EntitiesRequest, request: Request):
    """Multilingual NER with caching. See module docstring for full design."""
    ip = request.client.host if request.client else "?"

    # Per-IP rate limit. 429 is the right status; rare in practice but real
    # if someone scripts the endpoint.
    if not _check_rate_limit(ip):
        raise HTTPException(status_code=429, detail="rate_limit_exceeded")

    video_id = payload.video_id
    lang = _normalize_lang(payload.lang)
    text = payload.transcript_text

    word_count = len(text.split())
    t_hash = _transcript_hash(text)

    # 1. Cache lookup. Hits return the same shape as a fresh extraction
    # so the frontend doesn't need to branch on `source`.
    cached = await _cache_read(video_id, lang, t_hash)
    if cached is not None:
        print(
            f"[ENTITIES] cache HIT video_id={video_id} lang={lang} "
            f"source={cached.get('source')} entities={len(cached.get('entities') or [])}",
            flush=True,
        )
        return EntitiesResponse(
            entities=cached.get("entities") or [],
            source="cache",
            word_count=cached.get("word_count") or word_count,
            hallucinations_dropped=cached.get("hallucinations_dropped") or 0,
        )

    # 2. Cache miss. Route to spaCy if we have a model, else LLM.
    if _has_spacy_model(lang):
        # spaCy is CPU-bound — run in a worker thread so we don't block
        # the event loop. Same pattern as transcript_routes.py.
        result = await asyncio.to_thread(ner.analyze, text, lang)
        entities = result.get("entities") or []
        source = "spacy"
        hallucinations = 0
        print(
            f"[ENTITIES] spaCy MISS->extract video_id={video_id} lang={lang} "
            f"entities={len(entities)} words={word_count}",
            flush=True,
        )
    elif ner_llm.is_enabled():
        # LLM path — also CPU/IO bound. The OpenAI client is sync; wrap it.
        result = await asyncio.to_thread(ner_llm.analyze, text, lang)
        entities = result.get("entities") or []
        source = "llm"
        hallucinations = result.get("hallucinations_dropped") or 0
        print(
            f"[ENTITIES] LLM MISS->extract video_id={video_id} lang={lang} "
            f"entities={len(entities)} dropped={hallucinations} words={word_count}",
            flush=True,
        )
    else:
        # No spaCy model AND LLM kill-switch is off. Return empty so the
        # frontend gracefully shows no name highlights — same UX as today.
        print(
            f"[ENTITIES] unsupported lang={lang} (no spaCy model, LLM disabled) "
            f"video_id={video_id}",
            flush=True,
        )
        return EntitiesResponse(
            entities=[],
            source="unsupported",
            word_count=word_count,
            hallucinations_dropped=0,
        )

    # 3. Write to cache. Don't await — fire-and-forget so the response
    # returns immediately. Failures are logged inside `_cache_write` and
    # don't propagate; worst case a future request re-extracts.
    asyncio.create_task(_cache_write(
        video_id=video_id, lang=lang, t_hash=t_hash,
        entities=entities, source=source,
        word_count=word_count, hallucinations_dropped=hallucinations,
    ))

    return EntitiesResponse(
        entities=entities,
        source=source,
        word_count=word_count,
        hallucinations_dropped=hallucinations,
    )
