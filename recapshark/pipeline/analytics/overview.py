"""
Hero-stat overview endpoint (top-strip numbers on the analytics dashboard).

Owns: GET /overview plus the two compute paths it delegates to —
_overview_from_supabase (preferred, derives stats from rs_sessions so the
headline matches the rows beneath it) and _overview_compute (legacy BQ
fallback when the Supabase read fails).

Reads from: bq_client (_client, TABLE_GLOB), filters (filter_where_clause,
filter_params, csv_param), _session_filter (build_keep_predicate,
compute_chat_count_map), owner_resolver (resolved_owner_user_pseudo_ids),
response_cache (cached_response).

Imports allowed: stdlib + fastapi + google.cloud.bigquery + sibling analytics
modules + lazy supabase_sessions_store / chat_messages_store at call time.
"""

from datetime import date, timedelta

from fastapi import Query as FQuery
from google.cloud import bigquery

from . import router
from .bq_client import _client, TABLE_GLOB
from .filters import (
    csv_param,
    filter_where_clause,
    filter_params,
)
from ._session_filter import build_keep_predicate, compute_chat_count_map
from .owner_resolver import resolved_owner_user_pseudo_ids
from .response_cache import cached_response


def _overview_from_supabase(
    days, exclude_cities, exclude_countries, hide_unknown_cities, hide_owner,
    devices, landed_via, require_videos, require_extra_lang, require_chat,
):
    """Hero stats derived from the same filtered rs_sessions list the sessions
    tab uses, so the headline never disagrees with the rows beneath it.

    Reuses every filter pred from the supabase sessions path (city/country
    excludes, hide-owner, device, landed_via, require_videos/extra_lang/chat).
    Falls back to the BQ scan in the caller if rs_sessions read fails.
    """
    import supabase_sessions_store as _s

    end = date.today()
    start = end - timedelta(days=max(1, min(int(days or 1), 365)) - 1)
    rows = _s.fetch_sessions_window(start, end)

    _keep = build_keep_predicate(
        excl_cities=set(csv_param(exclude_cities)),
        excl_countries=set(csv_param(exclude_countries)),
        hide_unknown_cities=hide_unknown_cities,
        owner_ids=set(resolved_owner_user_pseudo_ids()) if hide_owner else set(),
        keep_devices={d.lower() for d in csv_param(devices) if d},
        keep_landed={v.lower() for v in csv_param(landed_via) if v},
        require_videos=require_videos,
        require_extra_lang=require_extra_lang,
        require_chat=require_chat,
        chat_count_map=compute_chat_count_map(start, end, enabled=require_chat),
    )

    filtered = [r for r in rows if _keep(r)]

    unique_users = len({r.get("user_pseudo_id") for r in filtered if r.get("user_pseudo_id")})
    sessions = len(filtered)
    countries = len({
        r.get("country") for r in filtered
        if r.get("country") and r.get("country") != "(not set)"
    })
    durations = [r.get("duration_sec") or 0 for r in filtered]
    avg_dur = int(round(sum(durations) / len(durations))) if durations else 0
    total_events = sum(int(r.get("event_count") or 0) for r in filtered)

    return {
        "unique_users": unique_users,
        "total_events": total_events,
        "sessions":     sessions,
        "countries":    countries,
        "avg_session_duration_sec": avg_dur,
        "days":         days,
    }


def _overview_compute(days, exclude_cities, exclude_countries, hide_unknown_cities, hide_owner):
    # Single CTE materializes the filtered event rows once and reuses them for
    # all five hero stats. The session_agg sub-aggregate gives us per-session
    # duration so the dashboard can show "average session duration" instead of
    # the raw "events" count (which was just a curiosity number with no
    # actionable meaning). total_events is kept in the response for any
    # backward-compat callers but no longer surfaced in the UI.
    query = f"""
    WITH base AS (
      SELECT
        user_pseudo_id,
        event_timestamp,
        geo.country AS country,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS sid
      FROM {TABLE_GLOB}
      WHERE {filter_where_clause()}
    ),
    session_agg AS (
      -- event_timestamp in the GA4 export is INT64 microseconds-since-epoch,
      -- not a TIMESTAMP. Convert before diffing or BQ rejects the query.
      SELECT
        TIMESTAMP_DIFF(
          TIMESTAMP_MICROS(MAX(event_timestamp)),
          TIMESTAMP_MICROS(MIN(event_timestamp)),
          SECOND
        ) AS duration_sec
      FROM base
      WHERE sid IS NOT NULL
      GROUP BY user_pseudo_id, sid
    ),
    base_stats AS (
      SELECT
        COUNT(DISTINCT user_pseudo_id) AS unique_users,
        COUNT(*) AS total_events,
        COUNT(DISTINCT IF(
          country IS NOT NULL AND country != '' AND country != '(not set)',
          country, NULL
        )) AS countries
      FROM base
    ),
    sess_stats AS (
      SELECT
        COUNT(*) AS sessions,
        AVG(duration_sec) AS avg_session_duration_sec
      FROM session_agg
    )
    SELECT
      b.unique_users,
      b.total_events,
      b.countries,
      s.sessions,
      s.avg_session_duration_sec
    FROM base_stats b CROSS JOIN sess_stats s
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=filter_params(exclude_cities, exclude_countries, hide_unknown_cities, hide_owner, days)
    )
    row = next(iter(_client().query(query, job_config=job_config).result()), None)
    if row is None:
        return {"unique_users": 0, "total_events": 0, "sessions": 0,
                "countries": 0, "avg_session_duration_sec": 0, "days": days}
    return {
        "unique_users": int(row.unique_users or 0),
        "total_events": int(row.total_events or 0),
        "sessions":     int(row.sessions or 0),
        "countries":    int(row.countries or 0),
        "avg_session_duration_sec": int(round(row.avg_session_duration_sec or 0)),
        "days":         days,
    }


@router.get("/overview")
def overview(
    days: int = FQuery(7, ge=1, le=365),
    exclude_cities: str = FQuery(""),
    exclude_countries: str = FQuery(""),
    hide_unknown_cities: bool = FQuery(False),
    hide_owner: bool = FQuery(False),
    devices: str = FQuery(""),
    landed_via: str = FQuery(""),
    require_videos: bool = FQuery(False),
    require_extra_lang: bool = FQuery(False),
    require_chat: bool = FQuery(False),
):
    """Hero stats for the dashboard top strip.

    Computed from the *same filtered rs_sessions list* the sessions tab uses,
    so the headline always matches the rows beneath it. Falls back to the
    legacy BQ scan only if the supabase read fails.

    Returns:
      - unique_users:  distinct user_pseudo_id
      - total_events:  summed event_count
      - sessions:      filtered row count
      - countries:     distinct non-null country values
      - avg_session_duration_sec: mean of duration_sec across filtered rows

    Phase 4c: 60-sec response cache, keyed by all filter params. Owner write
    endpoints invalidate the cache so confirms/revokes are reflected immediately.
    """
    key = (
        f"overview:{days}:{exclude_cities}:{exclude_countries}:{hide_unknown_cities}:{hide_owner}"
        f":{devices}:{landed_via}:{require_videos}:{require_extra_lang}:{require_chat}"
    )

    def _compute():
        try:
            return _overview_from_supabase(
                days, exclude_cities, exclude_countries, hide_unknown_cities, hide_owner,
                devices, landed_via, require_videos, require_extra_lang, require_chat,
            )
        except Exception:
            # rs_sessions read failed (e.g. Supabase blip) — fall back to the
            # legacy BQ scan. It only honors the original 5 filters; the new
            # device/landed/require_* toggles will silently revert to "all"
            # for the hero, which is better than rendering "!"s.
            return _overview_compute(
                days, exclude_cities, exclude_countries, hide_unknown_cities, hide_owner,
            )

    return cached_response(key, _compute)
