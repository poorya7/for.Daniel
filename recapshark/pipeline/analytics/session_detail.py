"""
Per-session detail endpoint.

Owns: GET /sessions/{user_pseudo_id}/{session_id} (meta block + chronological
event timeline for one session), and the Supabase-first implementation
_session_detail_from_supabase which returns the same shape so the dashboard
renderer doesn't care which source served the response.

Reads from: bq_client (_client, TABLE_GLOB), filters (SUFFIX_WHERE,
EVENT_PARAMS_STRUCT, suffix_range), owner_resolver (suspected_owner_ids).

Imports allowed: stdlib + typing + fastapi + google.cloud.bigquery + sibling
analytics modules + lazy supabase_sessions_store at call time.
"""

from typing import Optional

from fastapi import Path as FPath, Query as FQuery
from google.cloud import bigquery

from . import router
from .bq_client import _client, TABLE_GLOB
from .filters import SUFFIX_WHERE, EVENT_PARAMS_STRUCT, suffix_range
from .owner_resolver import suspected_owner_ids


def _session_detail_from_supabase(user_pseudo_id: str, session_id: int) -> Optional[dict]:
    """Phase 4b: hydrate the session detail entirely from rs_sessions.raw_events,
    no BigQuery hit. Returns None if the row doesn't exist (caller falls back to BQ).

    Shape matches the BQ path exactly so the dashboard's renderer doesn't care
    which source served the response — only the `source` field differs.
    """
    import supabase_sessions_store as _s
    row = _s.fetch_session(user_pseudo_id, session_id)
    if not row:
        return None

    raw_events = row.get("raw_events") or []
    events = []
    for e in raw_events:
        events.append({
            "ts":              e.get("ts"),
            "event_name":      e.get("event_name"),
            "page":            e.get("page"),
            "tab":             e.get("tab"),
            "video_id":        e.get("video_id"),
            "lang":            e.get("lang"),
            "theme":           e.get("theme"),
            "mode":            e.get("mode"),
            "chapter_index":   e.get("chapter_index"),
            # raw_events from the ETL doesn't have chapter_title_length / has_question_mark
            # / word_count yet (Phase 4a query was a minimal first cut). Surface as None
            # so the UI's `e.field != null` checks just hide them; will backfill in 5b.
            "chapter_title_length": None,
            "query_length":    e.get("query_length"),
            "word_count":      e.get("word_count"),
            "has_question_mark": None,
            "message_length":  e.get("message_length"),
            "format":          e.get("format"),
            "enabled":         e.get("enabled"),
        })

    return {
        "user_pseudo_id":  row.get("user_pseudo_id"),
        "session_id":      row.get("session_id"),
        "found":           True,
        "started_at":      row.get("started_at"),
        "ended_at":        row.get("ended_at"),
        "duration_sec":    int(row.get("duration_sec") or 0),
        "event_count":     int(row.get("event_count") or 0),
        "landing_page":    row.get("landing_page"),
        "exit_page":       row.get("exit_page"),
        "video_ids":       list(row.get("video_ids") or []),
        "city":            row.get("city"),
        "region":          row.get("region"),
        "country":         row.get("country"),
        "device":          row.get("device"),
        "os":              row.get("os"),
        "browser":         row.get("browser"),
        "events":          events,
        "is_suspected_owner": row.get("user_pseudo_id") in suspected_owner_ids(),
        "source":          "supabase",
    }


@router.get("/sessions/{user_pseudo_id}/{session_id}")
def session_detail(
    user_pseudo_id: str = FPath(...),
    session_id: int = FPath(...),
    days: int = FQuery(90, ge=1, le=365),
    source: str = FQuery("auto", pattern="^(auto|supabase|bq)$"),
):
    """Single session: meta block + chronological event timeline.

    Phase 4b: tries rs_sessions first (whole timeline lives in `raw_events` JSONB,
    no BQ hit). Falls back to BQ if the row doesn't exist yet (e.g. today's
    sessions before the ETL has caught up). `?source=bq` forces the live path;
    `?source=supabase` disables the fallback (useful for testing the cache).

    Default 90-day window applies only to the BQ path; Supabase lookups are
    keyed by (user_pseudo_id, session_id) with no time bound.
    """
    if source != "bq":
        try:
            import supabase_sessions_store as _s
            if _s.is_configured():
                hit = _session_detail_from_supabase(user_pseudo_id, session_id)
                if hit is not None:
                    return hit
                if source == "supabase":
                    return {"user_pseudo_id": user_pseudo_id, "session_id": session_id,
                            "found": False, "events": [], "source": "supabase"}
        except Exception:
            if source == "supabase":
                raise
            # else fall through to BQ

    start_suffix, end_suffix = suffix_range(days)
    query = f"""
    WITH events AS (
      SELECT
        TIMESTAMP_MICROS(event_timestamp) AS ts,
        event_name,
        event_timestamp,
        device.category AS device,
        device.operating_system AS os,
        device.web_info.browser AS browser,
        geo.city AS city,
        geo.region AS region,
        geo.country AS country,
        {EVENT_PARAMS_STRUCT}
      FROM {TABLE_GLOB}
      WHERE {SUFFIX_WHERE}
        AND user_pseudo_id = @uid
    )
    SELECT * FROM events
    WHERE p.session_id = @sid
    ORDER BY event_timestamp ASC
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("start_suffix", "STRING", start_suffix),
        bigquery.ScalarQueryParameter("end_suffix",   "STRING", end_suffix),
        bigquery.ScalarQueryParameter("uid", "STRING", user_pseudo_id),
        bigquery.ScalarQueryParameter("sid", "INT64",  session_id),
    ])
    events = []
    first_ts = last_ts = None
    pages, videos = [], set()
    device = os_ = browser = city = region = country = None
    for r in _client().query(query, job_config=job_config).result():
        p = r.p
        events.append({
            "ts": r.ts.isoformat() if r.ts else None,
            "event_name": r.event_name,
            "page": p["page"], "tab": p["tab"], "video_id": p["video_id"],
            "lang": p["lang"], "theme": p["theme"], "mode": p["mode"],
            "chapter_index": p["chapter_index"],
            "chapter_title_length": p["chapter_title_length"],
            "query_length": p["query_length"], "word_count": p["word_count"],
            "has_question_mark": p["has_question_mark"],
            "message_length": p["message_length"],
            "format": p["format"], "enabled": p["enabled"],
        })
        if p["page"]: pages.append(p["page"])
        if p["video_id"]: videos.add(p["video_id"])
        # Rolling "latest seen" so the meta block reflects end-of-session state.
        device = r.device or device
        os_    = r.os or os_
        browser = r.browser or browser
        city = r.city or city
        region = r.region or region
        country = r.country or country
        if first_ts is None: first_ts = r.ts
        last_ts = r.ts

    if not events:
        return {"user_pseudo_id": user_pseudo_id, "session_id": session_id,
                "found": False, "events": [], "source": "bq"}

    duration = int((last_ts - first_ts).total_seconds()) if first_ts and last_ts else 0
    return {
        "user_pseudo_id": user_pseudo_id,
        "session_id": session_id,
        "found": True,
        "started_at": first_ts.isoformat() if first_ts else None,
        "ended_at":   last_ts.isoformat() if last_ts else None,
        "duration_sec": duration,
        "event_count": len(events),
        "landing_page": pages[0] if pages else None,
        "exit_page":    pages[-1] if pages else None,
        "video_ids": sorted(videos),
        "city": city, "region": region, "country": country,
        "device": device, "os": os_, "browser": browser,
        "events": events,
        "is_suspected_owner": user_pseudo_id in suspected_owner_ids(),
        "source": "bq",
    }
