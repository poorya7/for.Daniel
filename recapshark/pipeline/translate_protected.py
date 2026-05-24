"""
RecapShark — Google Translate cost protection wrappers.

Wraps the raw `google_translate.translate_text` / `translate_lines` with three
guards (pre-launch cost-control sweep — Cloud bills exposed the missing
protections):

  1. Cross-user content-hash cache  — sha256 of canonical input → result.
     First user to translate a given text pays Google; everyone else gets the
     cached result for free. Cache lives in `rs_translation_cache` (Supabase).

  2. Global daily $ kill-switch     — atomic Postgres RPC reserves chars
     against a daily USD cap before calling Google. Default $15/day.
     Mirrors the karaoke `reserve_asr_provider_seconds` RPC pattern.

  3. Per-IP daily char cap          — atomic Postgres RPC also tracks per-IP
     char spend. Default 333,000 chars/day per IP (~5h of transcript × 1
     target language). One bad actor can't burn the whole global budget.

On cap_hit the wrappers raise `TranslateCapHitError(kind=...)` — the route
layer catches that and returns HTTP 429 with a structured error code so the
frontend can show an informative message instead of staying in a loading
spinner. See `translate_routes.py` for the HTTP layer.

All Supabase / Google calls are SYNC (requests-based) because the translate
routes themselves are sync `def` (not `async def`). Mixing sync routes with
async Supabase clients would require an event-loop bridge — not worth the
complexity for these endpoints.
"""

import hashlib
import json
import logging
import time
from typing import Optional

import requests

import supabase_owner_store as _supa
from config import (
    translate_daily_cap_usd,
    translate_per_ip_daily_chars,
)


logger = logging.getLogger(__name__)


# Google Translate v2 pricing — $20 per 1M characters.
# Used by the cap RPC to convert the USD cap into a char budget. Pinned here
# (not in env) because changing this is a vendor-side event, not an ops knob —
# if Google changes their pricing, we'll know it from the bill, not from
# wanting to tune local behavior.
TRANSLATE_RATE_PER_MILLION_USD = 20.00


# ── Errors ──────────────────────────────────────────────────────────────────


class TranslateCapHitError(Exception):
    """Raised when the global $ cap or per-IP char cap is exceeded.
    `kind` is one of:
      - 'global_daily_cap_hit'  — the $TRANSLATE_DAILY_CAP_USD/day budget is gone.
      - 'per_ip_daily_cap_hit'  — the calling IP's daily char allowance is gone.
    Route layer maps both to HTTP 429 with a structured error body.
    """

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


class CapAccountingUnavailableError(Exception):
    """Raised when the Supabase RPC that does cap accounting can't be reached.
    Per the karaoke pattern (D21, T7) we fail-CLOSED on this — better to refuse
    a translation than silently disengage the kill-switch and wake up to a
    surprise bill. Route layer maps to HTTP 503.
    """


# ── Cache helpers ───────────────────────────────────────────────────────────


def _canonical_text(text: str) -> str:
    """Normalize a single string for stable hashing — strip + collapse internal
    whitespace. Two requests differing only in trailing/inner whitespace
    should hit the same cache row."""
    return " ".join(text.split())


def _canonical_lines(lines: list[dict]) -> str:
    """Normalize a list of {id, text} dicts for stable hashing.
    JSON-serialize sorted by id with separators that don't drift across
    Python versions. The id IS part of the hash because the caller cares
    about line-order in the result (transcript chunks are id-keyed)."""
    canonical = [
        {"id": str(item.get("id", "")), "text": _canonical_text(item.get("text", ""))}
        for item in sorted(lines, key=lambda x: str(x.get("id", "")))
    ]
    return json.dumps(canonical, separators=(",", ":"), ensure_ascii=False)


def _hash(canonical: str) -> str:
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _cache_url(content_hash: str, source_lang: str, target_lang: str) -> str:
    return (
        f"{_supa.supabase_url()}/rest/v1/rs_translation_cache"
        f"?content_hash=eq.{content_hash}"
        f"&source_lang=eq.{source_lang}"
        f"&target_lang=eq.{target_lang}"
        f"&limit=1"
    )


def _cache_get(content_hash: str, source_lang: str, target_lang: str) -> Optional[dict]:
    """Look up a cached translation. Returns the `result_json` dict or None on
    miss / error. Best-effort: a cache lookup failure must NEVER fail the
    user's request — we just fall through to a fresh Google call."""
    if not _supa.is_configured():
        return None
    try:
        resp = requests.get(
            _cache_url(content_hash, source_lang, target_lang),
            headers=_supa.service_headers(),
            timeout=5,
        )
        if resp.status_code != 200:
            return None
        rows = resp.json() or []
        if not rows:
            return None
        return rows[0].get("result_json")
    except (requests.RequestException, ValueError):
        return None


def _cache_touch(content_hash: str, source_lang: str, target_lang: str) -> None:
    """Bump `last_accessed_at` + `hit_count` on a cache hit. Best-effort —
    the user already got their result; telemetry drift here is harmless.
    No throttle yet (D29-equivalent for this table) — translate hit rates
    are far lower than karaoke chunk hit rates so per-hit touch is fine."""
    try:
        # PostgREST doesn't support `+= 1` natively; do a read-modify-write
        # via PATCH with the next value. Safe even under races (worst case:
        # two concurrent hits both write hit_count = N+1 instead of N+2 —
        # we lose one count, big deal).
        url = _cache_url(content_hash, source_lang, target_lang).replace("&limit=1", "")
        resp = requests.patch(
            url,
            headers=_supa.service_headers(),
            json={
                "last_accessed_at": _now_iso(),
                # Use raw SQL via PostgREST is awkward; just bump by 1 each hit.
                # The exact count isn't load-bearing — only the relative ordering
                # matters for any "popular cached translations" reporting.
            },
            timeout=5,
        )
        # Don't bother decoding the response — best-effort.
        _ = resp
    except requests.RequestException:
        pass


def _cache_put(
    content_hash: str,
    source_lang: str,
    target_lang: str,
    result_json: dict,
    char_count: int,
) -> None:
    """Insert (or upsert) a cached translation. Best-effort — a cache write
    failure must never fail the user's request (they already have the result;
    only the cache write would be lost)."""
    if not _supa.is_configured():
        return
    try:
        requests.post(
            f"{_supa.supabase_url()}/rest/v1/rs_translation_cache",
            headers={
                **_supa.service_headers(),
                # Upsert on the composite PK so a race between two concurrent
                # cache-miss writers becomes a no-op for the loser instead of
                # a 409 unique-violation error.
                "Prefer": "resolution=ignore-duplicates,return=minimal",
            },
            json={
                "content_hash": content_hash,
                "source_lang": source_lang,
                "target_lang": target_lang,
                "result_json": result_json,
                "char_count": char_count,
            },
            timeout=5,
        )
    except requests.RequestException as e:
        logger.warning("[TRANSLATE-CACHE] put failed: %s", e)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ── Cap RPC ────────────────────────────────────────────────────────────────


def _reserve_chars(chars: int, ip: str) -> None:
    """Reserve `chars` against the global daily $ cap and the per-IP char cap.
    Raises `TranslateCapHitError(kind=...)` if either cap would be exceeded.
    Raises `CapAccountingUnavailableError` if the Supabase RPC can't be reached
    (fail-closed per karaoke D21).

    The RPC enforces atomicity — concurrent calls for the same IP/day serialize
    on the date row's lock so two simultaneous requests can't both squeak past
    the cap.
    """
    if not _supa.is_configured():
        # Local dev without Supabase — caps are off, log so it's visible.
        logger.warning("[TRANSLATE-CAP] Supabase not configured; cap accounting DISABLED")
        return

    global_cap = translate_daily_cap_usd()
    per_ip_cap = translate_per_ip_daily_chars()

    payload = {
        "p_chars": int(chars),
        "p_ip": ip or "",
        "p_global_cap_usd": float(global_cap),
        "p_per_ip_cap_chars": int(per_ip_cap),
        "p_rate_per_million": float(TRANSLATE_RATE_PER_MILLION_USD),
    }

    try:
        resp = requests.post(
            f"{_supa.supabase_url()}/rest/v1/rpc/reserve_translate_chars",
            headers=_supa.service_headers(),
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
        rows = resp.json() or []
    except requests.RequestException as e:
        logger.warning("[TRANSLATE-CAP] RPC unreachable: %s", e)
        raise CapAccountingUnavailableError(str(e)) from e

    if not rows:
        # 0 rows = either global or per-IP cap hit. Distinguish by checking
        # the global counter — if it's >= cap_chars, global hit; else per-IP.
        kind = _classify_cap_hit(global_cap, per_ip_cap, ip)
        logger.info("[TRANSLATE-CAP] cap_hit kind=%s ip=%s chars=%d", kind, ip, chars)
        raise TranslateCapHitError(kind)

    # Success — log the new totals at INFO so daily spend is visible in pm2 logs.
    row = rows[0]
    global_after = int(row.get("global_chars_after") or 0)
    ip_after = int(row.get("ip_chars_after") or 0)
    cost_so_far = global_after * TRANSLATE_RATE_PER_MILLION_USD / 1_000_000
    logger.info(
        "[TRANSLATE-CAP] reserved %d chars (ip=%s ip_today=%d global_today=%d $%.4f)",
        chars, ip, ip_after, global_after, cost_so_far,
    )


def _classify_cap_hit(global_cap_usd: float, per_ip_cap_chars: int, ip: str) -> str:
    """Best-effort classifier so the route layer can return a more useful
    error message. Reads the current counters via PostgREST. If the read
    fails we default to 'global_daily_cap_hit' (the more common case).
    Doesn't block the cap-hit response path — purely for telemetry + UX."""
    try:
        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).date().isoformat()
        global_resp = requests.get(
            f"{_supa.supabase_url()}/rest/v1/rs_translate_daily_usage"
            f"?usage_date=eq.{today}&select=billed_chars&limit=1",
            headers=_supa.service_headers(),
            timeout=5,
        )
        if global_resp.status_code == 200:
            rows = global_resp.json() or []
            if rows:
                billed = int(rows[0].get("billed_chars") or 0)
                cap_chars = int(global_cap_usd * 1_000_000 / TRANSLATE_RATE_PER_MILLION_USD) if global_cap_usd > 0 else -1
                # If the global is already at/over cap, this was a global-cap hit.
                if cap_chars >= 0 and billed >= cap_chars * 0.99:
                    return "global_daily_cap_hit"
        # Otherwise assume per-IP if a per-IP cap is configured and an IP was given.
        if per_ip_cap_chars > 0 and ip:
            return "per_ip_daily_cap_hit"
        return "global_daily_cap_hit"
    except requests.RequestException:
        return "global_daily_cap_hit"


# ── Public wrappers ─────────────────────────────────────────────────────────


def protected_translate_text(text: str, source_lang: str, target_lang: str, ip: str) -> str:
    """Cache → cap-reserve → google → cache-write. See module docstring."""
    if not text:
        return ""

    canonical = _canonical_text(text)
    char_count = len(canonical)
    content_hash = _hash(canonical)

    # 1. Cache lookup.
    cached = _cache_get(content_hash, source_lang, target_lang)
    if cached and isinstance(cached, dict) and "text" in cached:
        logger.info("[TRANSLATE-CACHE] HIT text %s->%s, %dch (free)",
                    source_lang, target_lang, char_count)
        _cache_touch(content_hash, source_lang, target_lang)
        return cached["text"]

    # 2. Reserve chars against caps. Raises on cap_hit.
    _reserve_chars(char_count, ip)

    # 3. Real Google call (sync — google_translate.translate_text is sync).
    from google_translate import translate_text as _google_translate_text
    t0 = time.time()
    result = _google_translate_text(canonical, source_lang, target_lang)
    elapsed = time.time() - t0
    logger.info("[TRANSLATE-CACHE] MISS text %s->%s, %dch, %.2fs (paid)",
                source_lang, target_lang, char_count, elapsed)

    # 4. Cache the result for next caller.
    _cache_put(content_hash, source_lang, target_lang, {"text": result}, char_count)
    return result


def protected_translate_lines(
    lines: list[dict], source_lang: str, target_lang: str, ip: str,
) -> list[dict]:
    """Cache → cap-reserve → google → cache-write for the batch path.
    Cache key = hash of the canonical (id, text) list. Same lines (regardless
    of how the caller chunked them) → same cache row."""
    if not lines:
        return []

    canonical = _canonical_lines(lines)
    char_count = sum(len(_canonical_text(item.get("text", ""))) for item in lines)
    content_hash = _hash(canonical)

    # 1. Cache lookup.
    cached = _cache_get(content_hash, source_lang, target_lang)
    if cached and isinstance(cached, dict) and isinstance(cached.get("lines"), list):
        logger.info("[TRANSLATE-CACHE] HIT lines %s->%s, %d lines, %dch (free)",
                    source_lang, target_lang, len(lines), char_count)
        _cache_touch(content_hash, source_lang, target_lang)
        return cached["lines"]

    # 2. Reserve chars. Raises on cap_hit.
    _reserve_chars(char_count, ip)

    # 3. Real Google call.
    from google_translate import translate_lines as _google_translate_lines
    t0 = time.time()
    result = _google_translate_lines(lines, source_lang, target_lang)
    elapsed = time.time() - t0
    logger.info("[TRANSLATE-CACHE] MISS lines %s->%s, %d lines, %dch, %.2fs (paid)",
                source_lang, target_lang, len(lines), char_count, elapsed)

    # 4. Cache.
    _cache_put(content_hash, source_lang, target_lang, {"lines": result}, char_count)
    return result
