"""
Sessions ETL — BigQuery → Supabase rs_sessions.

Reads completed event-day shards from BigQuery, aggregates into one row per
(user_pseudo_id, ga_session_id), and upserts into Supabase.

Designed to be:
  * Idempotent — re-running the same window updates rows in place; no duplicates.
  * Cheap — a single aggregation query per run; date-partition pruning via _TABLE_SUFFIX.
  * Safe — if Supabase is unreachable or BQ errors, the run row in rs_etl_runs
           captures the error so the dashboard can surface it.

Default window: 2 days (today + yesterday). Two days catches sessions that span
midnight (a session starting 23:55 bleeds into the next day's events shard)
without paying for a wider scan than necessary.

Phase 4d update — today's events are now included. GA4 streams them into
events_intraday_YYYYMMDD within minutes; we read both that and the finalized
events_YYYYMMDD shards via the SUFFIX_WHERE filter. Combined with an hourly
cron, Supabase mirrors live activity within ~1 hour.
"""

from __future__ import annotations

import os
import json
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, List, Optional

import httpx
from google.cloud import bigquery
from google.oauth2 import service_account

# Make sibling modules importable when this file is run as
# `python -m pipeline.etl_sessions` from /opt/recapshark (PM2 cron path).
# Without this, only /opt/recapshark is on sys.path and bare imports like
# `import supabase_owner_store` fail. No-op when pipeline/ is already on
# sys.path (the FastAPI process path).
import sys as _sys
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

import supabase_owner_store as _supa
import narrative as _narrative
import video_titles as _video_titles
import chat_messages_store as _chat_msgs
from config import recapshark_bq_key_path


# ── BigQuery client ─────────────────────────────────────────────────────────
PROJECT_ID = "gcp-PROJECT-ID"
DATASET = "analytics_PROPERTY_ID"
TABLE_GLOB = f"`{PROJECT_ID}.{DATASET}.events_*`"

_DEFAULT_KEY_PATH = os.path.join(os.path.dirname(__file__), "service-account.json")
_KEY_FILE = recapshark_bq_key_path(_DEFAULT_KEY_PATH)


def _bq_client() -> bigquery.Client:
    """Fresh client per run — ETL is invoked rarely enough that lru_cache buys nothing,
    and a fresh client sidesteps any stale-credentials surprises in long-lived processes.
    """
    creds = service_account.Credentials.from_service_account_file(_KEY_FILE)
    return bigquery.Client(project=PROJECT_ID, credentials=creds)


# ── window helpers ──────────────────────────────────────────────────────────
def _etl_window(days: int) -> tuple[str, str, date, date]:
    """Returns (start_suffix, end_suffix, start_date, end_date) for the last `days`
    event days, *inclusive of today*.

    Phase 4d — today is now included because we also read events_intraday_*
    (streaming export) which has events within minutes of them happening.
    Re-running the ETL is idempotent (upsert by session key), so a half-built
    today's session just gets fleshed out on the next cron tick.
    """
    days = max(1, min(int(days or 1), 90))
    end_date = date.today()
    start_date = end_date - timedelta(days=days - 1)
    return start_date.strftime("%Y%m%d"), end_date.strftime("%Y%m%d"), start_date, end_date


# Phase 4d — match daily AND today's intraday shard in one filter. See the
# corresponding constant in pipeline/analytics/filters.py for the rationale.
SUFFIX_WHERE = """(
    _TABLE_SUFFIX BETWEEN @start_suffix AND @end_suffix
    OR _TABLE_SUFFIX = CONCAT('intraday_', @end_suffix)
  )"""


# ── BigQuery aggregation ────────────────────────────────────────────────────
# One query produces everything we need to write a session row:
#   - meta (started/ended/duration, geo, device)
#   - aggregates (event_count, page_view_count)
#   - distinct arrays (videos, languages, query_lengths)
#   - the raw event timeline as an ARRAY<STRUCT> for JSONB storage
# Capped at 500 events per session — enough for any realistic story; protects against
# bot/crawler runaway sessions blowing up the JSONB blob.
_AGG_QUERY = f"""
WITH events_with_session AS (
  SELECT
    user_pseudo_id,
    event_timestamp,
    event_name,
    device.category AS device,
    device.operating_system AS os,
    device.web_info.browser AS browser,
    geo.city AS city,
    geo.region AS region,
    geo.country AS country,
    -- Session attribution: collected_traffic_source is per-event (session-scope),
    -- traffic_source is user-scope (first-touch). We coalesce so we still get a
    -- value even on older event rows that lack collected_traffic_source.
    -- COALESCE wrapped in IFNULL guards against the column missing entirely on
    -- legacy GA4 tables; SAFE_OFFSET-style access via STRUCT lookups would be
    -- safer but BQ doesn't expose it for missing struct fields, so we let the
    -- query fail fast on truly absent schemas.
    COALESCE(collected_traffic_source.manual_source, traffic_source.source) AS ts_source,
    COALESCE(collected_traffic_source.manual_medium, traffic_source.medium) AS ts_medium,
    COALESCE(collected_traffic_source.manual_campaign_name, traffic_source.name) AS ts_campaign,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'tab') AS tab,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'video_id') AS video_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'selected_language') AS lang,
    -- video_lang is the *source* language of the pasted video (e.g. 'en', 'es').
    -- Distinct from `lang` (selected_language), which is the *user's* chosen
    -- translation target. Logged by Analytics.videoLangDetected once the API
    -- has detected the video's language. See docs/_tech/06_ANALYTICS.md.
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'video_lang') AS video_lang,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'theme_name') AS theme,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'mode') AS mode,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'chapter_index') AS chapter_index,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'query_length') AS query_length,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'word_count') AS word_count,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'message_length') AS message_length,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'format') AS format,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'enabled') AS enabled
  FROM {TABLE_GLOB}
  WHERE {SUFFIX_WHERE}
    AND user_pseudo_id IS NOT NULL
)
SELECT
  user_pseudo_id,
  session_id,
  TIMESTAMP_MICROS(MIN(event_timestamp)) AS started_at,
  TIMESTAMP_MICROS(MAX(event_timestamp)) AS ended_at,
  TIMESTAMP_DIFF(TIMESTAMP_MICROS(MAX(event_timestamp)),
                 TIMESTAMP_MICROS(MIN(event_timestamp)), SECOND) AS duration_sec,
  COUNT(*) AS event_count,
  COUNTIF(event_name = 'page_view') AS page_view_count,
  ARRAY_AGG(page IGNORE NULLS ORDER BY event_timestamp ASC  LIMIT 1)[SAFE_OFFSET(0)] AS landing_page,
  ARRAY_AGG(page IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS exit_page,
  ARRAY_AGG(city    IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS city,
  ARRAY_AGG(region  IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS region,
  ARRAY_AGG(country IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS country,
  ARRAY_AGG(device  IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS device,
  ARRAY_AGG(os      IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS os,
  ARRAY_AGG(browser IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS browser,
  ARRAY_AGG(DISTINCT video_id IGNORE NULLS) AS video_ids,
  ARRAY_AGG(DISTINCT lang     IGNORE NULLS) AS languages_used,
  -- Traffic attribution + video lang both come from the EARLIEST event in the
  -- session (ASC order) — that's the moment the user landed / pasted. Later
  -- events overwrite nothing; we want the first signal, not the last.
  ARRAY_AGG(ts_source   IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS traffic_source,
  ARRAY_AGG(ts_medium   IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS traffic_medium,
  ARRAY_AGG(ts_campaign IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS traffic_campaign,
  ARRAY_AGG(video_lang  IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS video_lang,
  ARRAY_AGG(query_length IGNORE NULLS) AS query_lengths,
  ARRAY_AGG(STRUCT(
      TIMESTAMP_MICROS(event_timestamp) AS ts,
      event_name,
      page, tab, video_id, lang, theme, mode,
      chapter_index, query_length, word_count, message_length, format, enabled
    ) ORDER BY event_timestamp ASC LIMIT 500) AS raw_events
FROM events_with_session
WHERE session_id IS NOT NULL
GROUP BY user_pseudo_id, session_id
"""


# `derive_landed_via` was an inline copy of the helper in
# `pipeline/analytics/filters.py`; both now import from `pipeline.traffic_source`
# (leaf module — no circular-import risk).
from traffic_source import derive_landed_via as _derive_landed_via  # noqa: E402,F401


def _row_to_payload(r) -> dict:
    """Translate a BQ Row into a Supabase REST upsert payload.
    `raw_events` becomes JSONB; arrays map directly; timestamps go to ISO-8601.
    """
    raw_events = []
    for e in (r.raw_events or []):
        raw_events.append({
            "ts":            e["ts"].isoformat() if e.get("ts") else None,
            "event_name":    e.get("event_name"),
            "page":          e.get("page"),
            "tab":           e.get("tab"),
            "video_id":      e.get("video_id"),
            "lang":          e.get("lang"),
            "theme":         e.get("theme"),
            "mode":          e.get("mode"),
            "chapter_index": e.get("chapter_index"),
            "query_length":  e.get("query_length"),
            "word_count":    e.get("word_count"),
            "message_length": e.get("message_length"),
            "format":        e.get("format"),
            "enabled":       e.get("enabled"),
        })

    return {
        "user_pseudo_id":   r.user_pseudo_id,
        "session_id":       int(r.session_id),
        "started_at":       r.started_at.isoformat() if r.started_at else None,
        "ended_at":         r.ended_at.isoformat()   if r.ended_at   else None,
        "duration_sec":     int(r.duration_sec or 0),
        "event_count":      int(r.event_count or 0),
        "page_view_count":  int(r.page_view_count or 0),
        "landing_page":     r.landing_page,
        "exit_page":        r.exit_page,
        "city":             r.city,
        "region":           r.region,
        "country":          r.country,
        "device":           r.device,
        "os":               r.os,
        "browser":          r.browser,
        "video_ids":        list(r.video_ids or []),
        "languages_used":   list(r.languages_used or []),
        "traffic_source":   getattr(r, "traffic_source", None),
        "traffic_medium":   getattr(r, "traffic_medium", None),
        "landed_via":       _derive_landed_via(
                                getattr(r, "traffic_medium", None),
                                getattr(r, "traffic_source", None),
                            ),
        "video_lang":       getattr(r, "video_lang", None),
        "query_lengths":    [int(x) for x in (r.query_lengths or []) if x is not None],
        "raw_events":       raw_events,
        # narrative is filled in `_attach_narratives` after the whole batch is
        # built — needs the bulk-resolved video-title cache to enrich prose.
    }


def _parse_iso(ts: str) -> Optional[datetime]:
    """Tolerant ISO-8601 parser used for visit-context math. Accepts trailing Z."""
    if not ts:
        return None
    try:
        s = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _build_visit_contexts(payloads: List[dict]) -> dict[tuple[str, int], dict]:
    """Phase 5e: for every (uid, session_id) being upserted, compute:
      * is_first        — True when this is the user's earliest known session
      * visit_number    — 1-indexed across all known sessions for that user
      * days_since_first / hours_since_first — distance from earliest start

    Sources of "known sessions" are the union of:
      * what's already in rs_sessions for this uid
      * what's in the current ETL batch (covers the cold-start case where DB is
        empty but the batch itself contains multiple sessions per user)

    Returns {(uid, session_id): context_dict}. Empty dict on any error so the
    narrative just falls back to no visit-prefix.
    """
    if not payloads:
        return {}
    import supabase_sessions_store as _sess

    uids = sorted({p["user_pseudo_id"] for p in payloads if p.get("user_pseudo_id")})
    history = _sess.fetch_visit_history(uids)

    # Add the batch's own session-starts so cold-start runs still get correct
    # ordering (the rs_sessions read above won't have them yet on a fresh DB).
    for p in payloads:
        uid = p.get("user_pseudo_id")
        if not uid:
            continue
        history.setdefault(uid, []).append(p.get("started_at"))

    # Per-uid sorted unique start times (set() dedups when batch + DB overlap).
    sorted_starts: dict[str, list[datetime]] = {}
    for uid, raw_starts in history.items():
        parsed = sorted({_parse_iso(s) for s in raw_starts if s} - {None})
        sorted_starts[uid] = list(parsed)

    out: dict[tuple[str, int], dict] = {}
    for p in payloads:
        uid = p.get("user_pseudo_id")
        sid = int(p.get("session_id") or 0)
        my_start = _parse_iso(p.get("started_at"))
        starts = sorted_starts.get(uid) or []
        if not my_start or not starts:
            continue
        # bisect for prior count would be marginally faster; linear scan is
        # plenty at our per-user volume (max ~dozens of sessions).
        prior = sum(1 for s in starts if s < my_start)
        first = starts[0]
        delta = my_start - first
        days = max(0, delta.days)
        hours = max(0, int(delta.total_seconds() // 3600))
        out[(uid, sid)] = {
            "is_first":          (prior == 0),
            "visit_number":      prior + 1,
            "days_since_first":  days,
            "hours_since_first": hours,
        }
    return out


def _attach_narratives(payloads: List[dict], window_start: date, window_end: date) -> None:
    """Phase 5b + 5d + 5e: enrich each row with bulk-resolved video titles, any
    chat text logged in the window, and cross-session visit history, then build
    the narrative.

    All three lookups are bulk one-shots so per-row work stays O(1):
      * `video_titles.resolve_many` — Supabase cache + oEmbed for misses.
      * `chat_messages_store.fetch_for_window` — single PostgREST GET grouped
        by (user_pseudo_id, ga_session_id).
      * `_build_visit_contexts` — single rs_sessions GET, then in-memory math.
    """
    distinct_videos: set[str] = set()
    for p in payloads:
        for v in (p.get("video_ids") or []):
            if v:
                distinct_videos.add(v)
    titles = _video_titles.resolve_many(distinct_videos) if distinct_videos else {}
    chats = _chat_msgs.fetch_for_window(window_start, window_end) if payloads else {}
    visits = _build_visit_contexts(payloads)

    for p in payloads:
        row_titles = {v: titles.get(v) for v in (p.get("video_ids") or []) if v}
        key = (p.get("user_pseudo_id"), int(p.get("session_id") or 0))
        row_chat = [m["message"] for m in chats.get(key, [])]
        row_visit = visits.get(key)
        p["narrative"] = _narrative.build(
            p,
            video_titles=row_titles,
            chat_messages=row_chat,
            visit_context=row_visit,
        )


# ── Supabase upserts ────────────────────────────────────────────────────────
_BATCH_SIZE = 100   # keeps each REST payload under ~1MB even with 500-event raw_events


def _chunks(seq: List[dict], n: int) -> Iterable[List[dict]]:
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _upsert_sessions(rows: List[dict]) -> int:
    """Upsert sessions in batches. Returns the number of rows accepted by Supabase
    (which equals the number we sent on success — Supabase doesn't return a count
    distinct from the request size for `Prefer: return=minimal`).
    """
    if not rows:
        return 0
    if not _supa.is_configured():
        raise RuntimeError("Supabase env vars missing — cannot upsert sessions.")
    base = _supa._supabase_url()
    headers = {
        **_supa._service_headers(),
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    url = f"{base}/rest/v1/rs_sessions?on_conflict=user_pseudo_id,session_id"
    written = 0
    with httpx.Client(timeout=30.0) as c:
        for batch in _chunks(rows, _BATCH_SIZE):
            resp = c.post(url, headers=headers, json=batch)
            if resp.status_code >= 400:
                raise RuntimeError(f"Supabase upsert failed ({resp.status_code}): {resp.text[:300]}")
            written += len(batch)
    return written


# ── run audit log ───────────────────────────────────────────────────────────
_JOB_NAME = "sessions_nightly"


def _log_run_start(days_window: int) -> Optional[int]:
    if not _supa.is_configured():
        return None
    try:
        with httpx.Client(timeout=10.0) as c:
            resp = c.post(
                f"{_supa._supabase_url()}/rest/v1/rs_etl_runs",
                headers={**_supa._service_headers(), "Prefer": "return=representation"},
                json={"job_name": _JOB_NAME, "status": "running", "days_window": days_window},
            )
            if resp.status_code >= 400:
                return None
            data = resp.json() or []
            return int(data[0]["run_id"]) if data else None
    except httpx.HTTPError:
        return None


def _log_run_finish(run_id: Optional[int], status: str, rows_written: int, error_msg: Optional[str] = None) -> None:
    if run_id is None or not _supa.is_configured():
        return
    payload = {
        "status":       status,
        "rows_written": rows_written,
        "finished_at":  datetime.now(timezone.utc).isoformat(),
        "error_msg":    (error_msg or "")[:500] if error_msg else None,
    }
    try:
        with httpx.Client(timeout=10.0) as c:
            c.patch(
                f"{_supa._supabase_url()}/rest/v1/rs_etl_runs?run_id=eq.{run_id}",
                headers=_supa._service_headers(),
                json=payload,
            )
    except httpx.HTTPError:
        pass   # best-effort — don't fail the ETL because the audit log is down


# ── public entry point ──────────────────────────────────────────────────────
def run(days: int = 2) -> dict:
    """Run the sessions ETL for the last `days` *completed* event days.

    Returns a summary dict suitable for JSON serialization in an HTTP response.
    Never raises — captures exceptions in the rs_etl_runs row and the return value.
    """
    started_iso = datetime.now(timezone.utc).isoformat()
    start_suffix, end_suffix, start_date, end_date = _etl_window(days)
    run_id = _log_run_start(days)

    summary = {
        "job_name":     _JOB_NAME,
        "run_id":       run_id,
        "days_window":  days,
        "start_date":   start_date.isoformat(),
        "end_date":     end_date.isoformat(),
        "started_at":   started_iso,
        "status":       "running",
        "rows_read":    0,
        "rows_written": 0,
    }

    try:
        # Refresh the owner-identity allow-list before pulling sessions so the
        # dashboard's "Hide me" filter sees any new pseudo_ids the owner has
        # used since the last cron tick. Best-effort — a failed owner-scan
        # must NEVER break the session ETL (sessions are far more important
        # than owner filtering being one hour stale).
        #
        # 7-day window picks up Safari ITP rotations in batch even if a tick
        # is missed; the upsert is idempotent so re-scanning is cheap.
        try:
            from owner_scan import run_owner_scan
            scan_summary = run_owner_scan(days=7, auto_confirm=False)
            summary["owner_scan"] = scan_summary
        except Exception as _scan_err:
            summary["owner_scan_error"] = str(_scan_err)[:200]

        client = _bq_client()
        job_config = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("start_suffix", "STRING", start_suffix),
            bigquery.ScalarQueryParameter("end_suffix",   "STRING", end_suffix),
        ])
        rows = [_row_to_payload(r) for r in client.query(_AGG_QUERY, job_config=job_config).result()]
        summary["rows_read"] = len(rows)
        _attach_narratives(rows, start_date, end_date)   # 5b titles + 5d chat text
        summary["rows_written"] = _upsert_sessions(rows)
        summary["status"] = "success"
        _log_run_finish(run_id, "success", summary["rows_written"])
    except Exception as e:
        summary["status"] = "error"
        summary["error_msg"] = str(e)
        _log_run_finish(run_id, "error", summary["rows_written"], str(e))

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    return summary


if __name__ == "__main__":
    # CLI entry: `python -m pipeline.etl_sessions [days]`
    # When invoked standalone (e.g. PM2 cron), load .env ourselves — server.py
    # isn't in the loop, and we depend on SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
    # / RECAPSHARK_BQ_KEY_PATH being present. Same lightweight parser as
    # server.py to avoid pulling in python-dotenv just for this.
    import sys
    import logging as _logging
    from pathlib import Path as _Path
    _env_path = _Path(__file__).resolve().parent.parent / ".env"
    if _env_path.exists():
        with open(_env_path) as _f:
            for _line in _f:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    os.environ.setdefault(_k.strip(), _v.strip())
    # Phase 5: same logging baseline as server.py — without this, any
    # logger.info / logger.warning call from imported modules (analytics
    # store, supabase helpers, etc.) silently drops in pm2 logs because the
    # cron is its own process.
    _logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        force=True,
    )
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    result = run(n)
    # JSON summary on stdout — intentional CLI output, NOT observability.
    print(json.dumps(result, indent=2))
