"""
Read access to the precomputed `rs_sessions` table (Phase 4b).

Sister module to supabase_owner_store. Same patterns:
  * httpx + PostgREST, no SDK dependency
  * 60-sec TTL cache so a flurry of clicks doesn't hammer Supabase
  * Falls back to [] / None on any error so the dashboard degrades, not crashes
    (the BQ-backed code path in pipeline/analytics/sessions_list.py is the fallback)

We deliberately fetch the full date window in one call and filter / paginate in
Python. At our scale (~hundreds of sessions per fortnight) this is much simpler
than building PostgREST URLs with comma-quoted .in.() and not.in.() filters,
and the network/dump cost is tiny. If session volume ever grows past a few
thousand per window, switch to server-side filters then.
"""

from __future__ import annotations

import time
from datetime import date
from threading import Lock
from typing import List, Optional

import httpx

# Reuse the same configured-ness check + auth headers as the owner store.
import supabase_owner_store as _owner


# ── tiny TTL cache ──────────────────────────────────────────────────────────
_CACHE_TTL_SEC = 60
_cache: dict = {}
_cache_lock = Lock()


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        ts, value = entry
        if time.time() - ts > _CACHE_TTL_SEC:
            _cache.pop(key, None)
            return None
        return value


def _cache_set(key: str, value):
    with _cache_lock:
        _cache[key] = (time.time(), value)


def invalidate_cache():
    with _cache_lock:
        _cache.clear()


def is_configured() -> bool:
    return _owner.is_configured()


# ── reads ───────────────────────────────────────────────────────────────────
# Columns we need for the list endpoint. raw_events is heavy (JSONB blob per row),
# so it's deliberately excluded here and fetched only by fetch_session(uid, sid).
_LIST_COLS = (
    "user_pseudo_id,session_id,started_at,ended_at,duration_sec,event_count,"
    "page_view_count,landing_page,exit_page,city,region,country,device,os,browser,"
    "video_ids,languages_used,query_lengths,narrative,"
    # Phase 4f (2026-04-22) — traffic-source attribution + main video lang.
    # See pipeline/migrations/2026_04_22_add_traffic_source_and_video_lang.sql.
    "traffic_source,traffic_medium,landed_via,video_lang"
)


def fetch_sessions_window(start_date: date, end_date: date, hard_cap: int = 5000) -> List[dict]:
    """All sessions that started in [start_date, end_date+1day) UTC, newest first.

    Inclusive on both ends — `end_date` is the latest day to include. The query
    filters by `started_at` (PostgreSQL `timestamptz`), so a session that
    started 23:59 on `end_date` and finished tomorrow is included.

    `hard_cap` defends against runaway responses if someone widens the window
    aggressively. PostgREST's default page size (1000) is bypassed with the
    Range header so we don't silently truncate a 1500-row window.
    """
    if not is_configured():
        return []
    cache_key = f"window:{start_date.isoformat()}:{end_date.isoformat()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Half-open upper bound. We extend it 2 days past `end_date` (rather than 1)
    # because `end_date` comes from the server's *local* date.today(), but
    # started_at is stored in UTC. A session at 10pm local time (e.g. EDT) has
    # a UTC timestamp on the *next* day — extending the bound covers that
    # ~5h timezone tail without needing the user's TZ. The lower bound is
    # symmetrically generous already (gte.start_date 00:00:00Z includes events
    # from the prior local evening that rolled into UTC overnight).
    next_day = date.fromordinal(end_date.toordinal() + 2)
    url = (
        f"{_owner.supabase_url()}/rest/v1/rs_sessions"
        f"?select={_LIST_COLS}"
        f"&started_at=gte.{start_date.isoformat()}T00:00:00Z"
        f"&started_at=lt.{next_day.isoformat()}T00:00:00Z"
        f"&order=started_at.desc"
    )
    headers = {
        **_owner.service_headers(),
        # Range = full window. PostgREST returns up to (Range_end - Range_start + 1) rows.
        "Range-Unit": "items",
        "Range": f"0-{hard_cap - 1}",
    }
    try:
        with httpx.Client(timeout=10.0) as c:
            resp = c.get(url, headers=headers)
            if resp.status_code >= 400:
                return []
            rows = resp.json() or []
    except httpx.HTTPError:
        return []

    _cache_set(cache_key, rows)
    return rows


# ── visit history (Phase 5e) ───────────────────────────────────────────────
def fetch_visit_history(user_pseudo_ids: List[str]) -> dict[str, list[str]]:
    """Returns {user_pseudo_id: [started_at_iso, ...]} for every existing
    rs_sessions row belonging to one of the given users, sorted ascending.

    Used by the ETL to derive each session's visit number and "days since first
    visit" without per-row round-trips. Falls back to {} on error (so visit
    context just gets skipped — narratives still render fine without it).

    `select=` is intentionally minimal (no raw_events / narrative) so even if
    a user has hundreds of sessions the response stays tiny.
    """
    if not user_pseudo_ids or not is_configured():
        return {}
    # PostgREST `in.(...)` accepts comma-separated values; user_pseudo_ids are
    # GA cookies (digits + dot), so no escaping needed.
    ids_csv = ",".join(user_pseudo_ids)
    url = (
        f"{_owner.supabase_url()}/rest/v1/rs_sessions"
        f"?select=user_pseudo_id,started_at"
        f"&user_pseudo_id=in.({ids_csv})"
        f"&order=started_at.asc"
    )
    headers = {
        **_owner.service_headers(),
        "Range-Unit": "items",
        "Range": "0-19999",   # generous: 20k starts covers >100 prolific users
    }
    try:
        with httpx.Client(timeout=15.0) as c:
            resp = c.get(url, headers=headers)
            if resp.status_code >= 400:
                return {}
            rows = resp.json() or []
    except httpx.HTTPError:
        return {}

    grouped: dict[str, list[str]] = {}
    for r in rows:
        uid = r.get("user_pseudo_id")
        ts = r.get("started_at")
        if not uid or not ts:
            continue
        grouped.setdefault(uid, []).append(ts)
    return grouped


# Detail rows include the JSONB raw_events timeline — heavy, so cache them per
# session-key with a longer TTL (the data is immutable post-ETL; only narrative
# might be patched in later phases, and we'll invalidate on those writes).
def fetch_session(user_pseudo_id: str, session_id: int) -> Optional[dict]:
    if not is_configured() or not user_pseudo_id:
        return None
    cache_key = f"sess:{user_pseudo_id}:{session_id}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    url = (
        f"{_owner.supabase_url()}/rest/v1/rs_sessions"
        f"?select=*"
        f"&user_pseudo_id=eq.{user_pseudo_id}"
        f"&session_id=eq.{int(session_id)}"
        f"&limit=1"
    )
    try:
        with httpx.Client(timeout=10.0) as c:
            resp = c.get(url, headers=_owner.service_headers())
            if resp.status_code >= 400:
                return None
            data = resp.json() or []
    except httpx.HTTPError:
        return None

    row = data[0] if data else None
    if row:
        _cache_set(cache_key, row)
    return row
