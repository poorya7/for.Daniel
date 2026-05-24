"""LLM-based multilingual NER fallback for languages spaCy can't handle.

Companion to `ner.py`. Same public shape (`analyze(text, lang) -> dict`) so
callers can route to either module based on language support.

Why this exists
---------------
spaCy ships official NER models for ~24 languages — Persian, Arabic, Hindi,
Korean, Thai, Vietnamese and most non-Latin / low-resource languages have no
model at all. RecapShark targets ~100 caption languages, so spaCy alone hard-
caps coverage. This module fills the gap with structured-output LLM calls
that work in any language the underlying model speaks.

Design notes
------------
- **gpt-4o-mini, JSON object response format.** Cheap (~$0.005-0.02 per
  long video), multilingual, deterministic enough at temperature=0.

- **Hallucination guard is load-bearing.** Every returned entity is
  checked against the source text — non-matches dropped silently. Without
  this, the model invents plausible-sounding names ("Joe Smith") that
  would highlight as fake hits in the transcript. See `_filter_hallucinations`.

- **Chunked extraction for long transcripts.** A single LLM call to
  gpt-4o-mini caps output at 16k tokens. On a 7000+ word Persian podcast
  the model can blow past that cap (verbose JSON + duplicate emissions)
  and the response gets truncated mid-string — JSON parse fails and we
  end up caching zero entities forever. We split anything over
  `_CHUNK_SIZE_CHARS` into overlapping chunks, run them in parallel via
  a small ThreadPoolExecutor, and merge + dedupe results. Overlap catches
  multi-word names that straddle chunk boundaries.

- **Hard output cap per chunk.** `max_completion_tokens=4000` makes a
  runaway model fail loudly (we get a finish_reason='length' and detect
  it) instead of silently returning garbage. With ~5k-word chunks this
  is comfortable headroom — well under the 16k model cap.

- **Compact JSON output.** Pretty-printed JSON wastes ~30% of the output
  budget on whitespace. The system prompt instructs the model to emit
  minified JSON; the parser handles both forms regardless.

- **Graceful failure.** Any error path returns `{"entities": []}` and
  logs to stderr. Never raises — the highlight pipeline must keep working
  even when this module is broken.

- **Caching is the caller's job.** This module is stateless — every call
  is a real LLM round-trip. The `/api/entities` endpoint owns the
  Supabase `rs_video_entities` cache so this stays focused on extraction.

Activation
----------
Set `ENABLE_LLM_NER=true` in `.env` to enable. Off by default — kill switch
for instant rollback if costs spike or quality regresses.
"""
from __future__ import annotations

import json
from config import enable_llm_ner as _enable_llm_ner
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

# ── Tunables ─────────────────────────────────────────────────────────────
# Temperature: 0 for deterministic output. The same transcript should always
# return the same entities, otherwise our cache is meaningless.
_TEMPERATURE = 0.0

# Chunk size for splitting long transcripts. Empirically tuned over multiple
# rounds on a 53-min Persian podcast (37,849 chars):
#   - 25k chunks: chunk 2 hit the 4k output cap and returned 0 entities.
#   - 12k chunks: chunk 2 still hit the 8k output cap (model produced ~16k
#     tokens of duplicates / variants before retrying internally — total
#     130s on one chunk).
#   - 6k chunks: every chunk fits comfortably even on entity-dense regions.
# Cost is unchanged (same total tokens), latency is similar (more chunks
# but more parallelism). 6 chunks for a 38k transcript is a fine trade.
_CHUNK_SIZE_CHARS = 6_000

# Overlap between consecutive chunks. A multi-word name straddling a chunk
# boundary ("ولادیمیر" at end of chunk N, "لنین" at start of chunk N+1) gets
# missed without overlap because each chunk is fed to the LLM separately.
# 500 chars (~100 English words / many Persian sentences) is generous enough
# to catch any realistic surface form, while small enough that the duplicate
# work across chunks is negligible.
_CHUNK_OVERLAP_CHARS = 500

# Hard cap on output tokens per chunk. 4k is plenty for a 6k-char chunk
# (typical output 500-1500 tokens). If we see `finish_reason='length'`
# the model is misbehaving (looping, emitting duplicates) and we want to
# fail that chunk loudly rather than burn 30s on retries — `_API_TIMEOUT`
# below caps the per-chunk wall time.
_MAX_OUTPUT_TOKENS_PER_CHUNK = 4000

# Per-chunk OpenAI API timeout. The default OpenAI client timeout is 10
# minutes — way too long. With 6k-char chunks the model should respond in
# 5-15s; 30s gives 2x margin. If a chunk genuinely takes longer the model
# is misbehaving and we'd rather fail-and-skip than block the whole
# extraction. The other chunks still produce their entities.
_API_TIMEOUT = 30.0

# Parallelism for chunked extraction. Each chunk is one OpenAI request;
# 4 in flight at once keeps wall-clock latency low without hammering rate
# limits. For a 60k-char transcript that's 3 chunks → all run in parallel.
_CHUNK_WORKERS = 4

# Absolute max input size we'll attempt. 1M chars ≈ 200k words ≈ a 12+
# hour podcast. Realistic ceiling — beyond this, chunk count gets unwieldy
# and the dedup pass starts dominating. We log + truncate, never raise.
_MAX_INPUT_CHARS = 1_000_000

# Model. gpt-4o-mini is the cheapest model with reliable structured output
# and good multilingual NER. Don't downgrade to a 3.5-class model — they
# hallucinate entities aggressively, and our hallucination guard would drop
# most of them, defeating the point.
_MODEL = "gpt-4o-mini"

# Same taxonomy as `ner.py` so the frontend can use one regex pipeline for
# both spaCy and LLM output. Anything not in this set is dropped.
_VALID_TYPES = frozenset(["PERSON", "ORG", "GPE", "EVENT", "DATE", "NUM"])


# ── State ────────────────────────────────────────────────────────────────
# Lazy-imported OpenAI client. Module-level cache so repeat calls don't
# re-import / re-construct.
_client = None


def is_enabled() -> bool:
    """True iff LLM-based NER should run. Cheap; called per request."""
    return _enable_llm_ner()


def _get_client():
    """Lazy-load the OpenAI client. Reuses the project's existing helper.

    Returns None on any error so callers can graceful-no-op without
    needing to know about OpenAI.
    """
    global _client
    if _client is not None:
        return _client
    try:
        from openai_client import get_client as _project_get_client
        _client = _project_get_client()
        return _client
    except Exception as e:
        print(f"[NER_LLM] OpenAI client unavailable: {e}", file=sys.stderr, flush=True)
        return None


_SYSTEM_PROMPT = (
    "You are a multilingual named-entity extractor for video transcripts.\n"
    "\n"
    "Extract every named entity that appears VERBATIM in the user's transcript text. "
    "Return them as MINIFIED JSON in this exact shape (no whitespace, no newlines):\n"
    '  {"entities":[{"text":"<surface form>","type":"<TYPE>"}]}\n'
    "\n"
    "Allowed types (use these exact labels, case-sensitive):\n"
    "  PERSON  — people's names (real or fictional)\n"
    "  ORG     — organizations, companies, agencies, teams, brands\n"
    "  GPE     — countries, cities, states, regions, geographical/political entities\n"
    "  EVENT   — named events (Super Bowl, World Cup, named conferences, named wars)\n"
    "  DATE    — natural-language dates and time references (yesterday, next Friday, Q3 2024)\n"
    "  NUM     — word-form numbers, money, percentages, quantities (twenty dollars, ten percent, three meters)\n"
    "\n"
    "Critical rules:\n"
    "1. Return only entities that appear LITERALLY in the transcript. Do not invent.\n"
    "2. Use the exact surface form from the transcript — don't normalize spelling, "
    "don't translate, don't expand abbreviations.\n"
    "3. Skip pure digits ('2024', '50%', '$100') — those are handled separately. "
    "Only extract DATE/NUM in their word form.\n"
    "4. Skip pronouns and common nouns. Only proper nouns and the typed forms above.\n"
    "5. Each unique surface form must appear at most ONCE in your output array, "
    "even if mentioned many times in the transcript.\n"
    "6. Output minified JSON only — no indentation, no extra whitespace.\n"
    "7. If the transcript has no entities, return {\"entities\":[]}.\n"
    "8. Languages: extract in whatever language(s) the transcript is written in. "
    "A single transcript may mix languages (code-switching) — extract all entities you find."
)


def _filter_hallucinations(entities: list[dict], text: str) -> tuple[list[dict], list[dict]]:
    """Drop any entity whose surface form doesn't appear in the source text.

    Defends against the model's tendency to invent plausible-sounding names.
    Match is case-insensitive substring — a stricter word-bounded check would
    drop legitimate entities at the start/end of sentences with adjacent
    punctuation, so we keep it loose. The frontend regex already enforces
    word boundaries when applying highlights, so a loose check here is fine.

    Returns (kept, dropped) for telemetry. `dropped` is logged but otherwise
    ignored — the caller surfaces only `kept`.
    """
    text_lower = text.lower()
    kept: list[dict] = []
    dropped: list[dict] = []
    for ent in entities:
        surface = (ent.get("text") or "").strip()
        ftype = (ent.get("type") or "").strip()
        if not surface or len(surface) < 2:
            dropped.append({"text": surface, "type": ftype, "reason": "too_short"})
            continue
        if ftype not in _VALID_TYPES:
            dropped.append({"text": surface, "type": ftype, "reason": "bad_type"})
            continue
        if surface.lower() not in text_lower:
            dropped.append({"text": surface, "type": ftype, "reason": "hallucinated"})
            continue
        kept.append({"text": surface, "type": ftype})
    return kept, dropped


def _dedupe(entities: list[dict]) -> list[dict]:
    """Keep one entry per (lowercased text, type) pair, preserving first-seen order."""
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for ent in entities:
        key = (ent["text"].lower(), ent["type"])
        if key in seen:
            continue
        seen.add(key)
        out.append(ent)
    return out


def _split_into_chunks(text: str, chunk_size: int, overlap: int) -> list[str]:
    """Split `text` into ~chunk_size pieces with `overlap` chars of context
    bleeding from the end of chunk N into the start of chunk N+1.

    Why overlap matters: a multi-word entity ("ولادیمیر لنین") that straddles
    a chunk boundary is invisible to both chunks without overlap — chunk N
    sees only "ولادیمیر", chunk N+1 sees only "لنین". 500 chars of overlap
    catches every realistic surface form across all scripts.

    No "smart" boundary detection (sentence breaks, etc.) — entity extraction
    is robust to mid-sentence chunk cuts because the LLM only emits entities
    it sees verbatim, and the overlap window guarantees both halves see the
    full entity. Mid-word cuts produce garbage chunks that the LLM correctly
    ignores; no extra logic needed.
    """
    if len(text) <= chunk_size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - overlap
    return chunks


def _extract_one_chunk(client, text: str, lang: str, chunk_idx: int, total_chunks: int) -> dict:
    """Run a single LLM extraction on `text` and validate against `text`.

    Returns `{entities: [...], hallucinations_dropped: int}` or empty on any
    failure. Logs each chunk separately so server logs make it clear which
    chunk(s) misbehaved on a multi-chunk run.
    """
    chunk_label = f"chunk {chunk_idx + 1}/{total_chunks}"
    try:
        response = client.chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            temperature=_TEMPERATURE,
            max_completion_tokens=_MAX_OUTPUT_TOKENS_PER_CHUNK,
            response_format={"type": "json_object"},
            timeout=_API_TIMEOUT,
        )
        raw = response.choices[0].message.content or ""
        finish_reason = response.choices[0].finish_reason
    except Exception as e:
        # Includes openai.APITimeoutError when the per-chunk timeout fires
        # — that's the intended fail-fast path for misbehaving chunks.
        # Other chunks unaffected.
        print(f"[NER_LLM] {chunk_label} OpenAI call failed (lang={lang}): {e}",
              file=sys.stderr, flush=True)
        return {"entities": [], "hallucinations_dropped": 0}

    if finish_reason == "length":
        # Hit the per-chunk output cap — output is truncated, JSON likely
        # invalid. Loud signal that the model is over-producing for this
        # chunk (rare with our chunk size; if it shows up consistently we
        # lower _CHUNK_SIZE_CHARS). Don't try to salvage; return empty so
        # the rest of the run still benefits from the working chunks.
        print(f"[NER_LLM] {chunk_label} hit output cap (finish_reason=length, lang={lang}); "
              f"returning empty for this chunk. Other chunks unaffected.",
              file=sys.stderr, flush=True)
        return {"entities": [], "hallucinations_dropped": 0}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"[NER_LLM] {chunk_label} malformed JSON (lang={lang}): {e}; "
              f"raw_head={raw[:200]!r}", file=sys.stderr, flush=True)
        return {"entities": [], "hallucinations_dropped": 0}

    raw_entities = data.get("entities", [])
    if not isinstance(raw_entities, list):
        print(f"[NER_LLM] {chunk_label} entities not a list (lang={lang}): "
              f"{type(raw_entities).__name__}", file=sys.stderr, flush=True)
        return {"entities": [], "hallucinations_dropped": 0}

    # Validate against THIS chunk's text — every entity the LLM emits for
    # this chunk must appear verbatim in this chunk. Cross-chunk validation
    # would be wrong: an entity from chunk 1 might not appear in chunk 2's
    # text, but it's still a valid extraction from chunk 1.
    kept, dropped = _filter_hallucinations(raw_entities, text)
    return {"entities": kept, "hallucinations_dropped": len(dropped)}


def analyze(text: str, lang: str = "en") -> dict:
    """Public entry point. Returns:
        {
          "entities": [{"text": "...", "type": "PERSON"}, ...],
          "hallucinations_dropped": int,   # for monitoring (sum across chunks)
          "source": "llm",                 # always 'llm' from this module
        }

    Always returns a valid dict — never raises. If LLM NER is disabled,
    the OpenAI client fails to load, or every chunk errors out, returns
    `{"entities": [], "hallucinations_dropped": 0, "source": "llm"}`.

    For inputs over `_CHUNK_SIZE_CHARS`, splits into overlapping chunks and
    extracts in parallel. Single-chunk inputs go through the same code path
    (one chunk in, one chunk out) so there's no separate fast path to keep
    in sync.
    """
    empty = {"entities": [], "hallucinations_dropped": 0, "source": "llm"}

    if not is_enabled():
        return empty
    if not text or len(text.strip()) < 20:
        return empty

    client = _get_client()
    if client is None:
        return empty

    # Hard ceiling — we can't extract from 50h of audio without rethinking
    # the design. Truncate + log; the user gets entities for the first N
    # hours, which beats failing entirely.
    truncated = False
    if len(text) > _MAX_INPUT_CHARS:
        print(
            f"[NER_LLM] transcript too long ({len(text)} chars), truncating to "
            f"{_MAX_INPUT_CHARS} for lang={lang}.",
            file=sys.stderr, flush=True
        )
        text = text[:_MAX_INPUT_CHARS]
        truncated = True

    chunks = _split_into_chunks(text, _CHUNK_SIZE_CHARS, _CHUNK_OVERLAP_CHARS)
    total = len(chunks)

    if total == 1:
        result = _extract_one_chunk(client, chunks[0], lang, 0, 1)
        kept = _dedupe(result["entities"])
        print(
            f"[NER_LLM] lang={lang} kept={len(kept)} "
            f"dropped={result['hallucinations_dropped']} chunks=1 truncated={truncated}",
            flush=True
        )
        return {
            "entities": kept,
            "hallucinations_dropped": result["hallucinations_dropped"],
            "source": "llm",
        }

    # Multi-chunk: run in parallel. ThreadPoolExecutor is fine here — the
    # OpenAI client is sync HTTP I/O, so the GIL is released during network
    # waits and we get real parallelism. Cap workers at _CHUNK_WORKERS to
    # avoid thrashing the rate limits.
    workers = min(_CHUNK_WORKERS, total)
    print(
        f"[NER_LLM] lang={lang} input={len(text)} chars → {total} chunks "
        f"(workers={workers})",
        flush=True
    )
    results: list[dict] = []
    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [
                ex.submit(_extract_one_chunk, client, chunk, lang, i, total)
                for i, chunk in enumerate(chunks)
            ]
            for f in futures:
                results.append(f.result())
    except Exception as e:
        # Pool failure is rare (we already swallow per-chunk errors); log
        # and return whatever finished. Still better than empty.
        print(f"[NER_LLM] chunk pool error (lang={lang}): {e}",
              file=sys.stderr, flush=True)

    merged: list[dict] = []
    total_dropped = 0
    for r in results:
        merged.extend(r.get("entities") or [])
        total_dropped += r.get("hallucinations_dropped", 0)
    deduped = _dedupe(merged)

    print(
        f"[NER_LLM] lang={lang} kept={len(deduped)} "
        f"(merged={len(merged)} pre-dedupe) dropped={total_dropped} "
        f"chunks={total} truncated={truncated}",
        flush=True
    )

    return {
        "entities": deduped,
        "hallucinations_dropped": total_dropped,
        "source": "llm",
    }
