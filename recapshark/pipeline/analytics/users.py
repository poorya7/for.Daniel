"""
User-list + per-user endpoints (timeline, profile, sessions wrapper).

Owns: GET /users (paginated list) + _users_compute. GET /timeline/{uid}
(chronological event list for one user). GET /users/{uid} (cross-session
profile = lifetime totals + recent sessions). GET /users/{uid}/sessions
(thin wrapper over /sessions filtered to one user).

Reads from: bq_client (_client, TABLE_GLOB), filters (SUFFIX_WHERE,
EVENT_PARAMS_STRUCT, suffix_range, filter_where_clause, filter_params),
owner_resolver (suspected_owner_ids), pagination (paginate),
response_cache (cached_response), sibling sessions_list module
(sessions_list — single source of truth for per-user session shape).

Imports allowed: stdlib + fastapi + google.cloud.bigquery + sibling analytics
modules. The sessions_list import is one-way (users → sessions_list).
"""

from fastapi import Path as FPath, Query as FQuery
from google.cloud import bigquery

from . import router
from .bq_client import _client, TABLE_GLOB
from .filters import (
    SUFFIX_WHERE,
    EVENT_PARAMS_STRUCT,
    suffix_range,
    filter_where_clause,
    filter_params,
)
from .owner_resolver import suspected_owner_ids
from .pagination import paginate
from .response_cache import cached_response
from .sessions_list import sessions_list


def _users_compute(days, exclude_cities, exclude_countries, hide_unknown_cities, hide_owner, limit, offset):
    query = f"""
    SELECT
      user_pseudo_id,
      COUNT(*) AS event_count,
      COUNT(DISTINCT (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id')) AS session_count,
      TIMESTAMP_MICROS(MIN(event_timestamp)) AS first_seen,
      TIMESTAMP_MICROS(MAX(event_timestamp)) AS last_seen,
      ARRAY_AGG(geo.city                IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS city,
      ARRAY_AGG(geo.region              IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS region,
      ARRAY_AGG(geo.country             IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS country,
      ARRAY_AGG(device.category         IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS device,
      ARRAY_AGG(device.operating_system IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS os,
      ARRAY_AGG(device.web_info.browser IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS browser
    FROM {TABLE_GLOB}
    WHERE user_pseudo_id IS NOT NULL
      AND {filter_where_clause()}
    GROUP BY user_pseudo_id
    ORDER BY last_seen DESC
    LIMIT @limit OFFSET @offset
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            *filter_params(exclude_cities, exclude_countries, hide_unknown_cities, hide_owner, days),
            # Fetch limit+1 so we can flag has_more without an extra COUNT(*) query.
            bigquery.ScalarQueryParameter("limit", "INT64", limit + 1),
            bigquery.ScalarQueryParameter("offset", "INT64", offset),
        ]
    )
    suspected = suspected_owner_ids()
    raw_rows = []
    for r in _client().query(query, job_config=job_config).result():
        raw_rows.append({
            "user_pseudo_id": r.user_pseudo_id,
            "event_count": r.event_count,
            "session_count": r.session_count,
            "first_seen": r.first_seen.isoformat() if r.first_seen else None,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
            "city": r.city,
            "region": r.region,
            "country": r.country,
            "device": r.device,
            "os": r.os,
            "browser": r.browser,
            "is_suspected_owner": r.user_pseudo_id in suspected,
        })
    return paginate(raw_rows, limit, offset)


@router.get("/users")
def users_list(
    days: int = FQuery(7, ge=1, le=365),
    exclude_cities: str = FQuery(""),
    exclude_countries: str = FQuery(""),
    hide_unknown_cities: bool = FQuery(False),
    hide_owner: bool = FQuery(False),
    limit: int = FQuery(100, ge=1, le=500),
    offset: int = FQuery(0, ge=0, le=10_000),
):
    """All users with summary stats, filtered. Default window: last 7 days.

    Phase 3.5.3: geo + device fields use ARRAY_AGG(... ORDER BY event_timestamp DESC LIMIT 1)
    instead of ANY_VALUE so traveling users don't flicker between cities between runs —
    they always show the most recent value seen in the window.

    Phase 4c: 60-sec response cache, keyed by all filter + paging params.
    """
    key = f"users:{days}:{exclude_cities}:{exclude_countries}:{hide_unknown_cities}:{hide_owner}:{limit}:{offset}"
    return cached_response(key, lambda: _users_compute(
        days, exclude_cities, exclude_countries, hide_unknown_cities, hide_owner, limit, offset,
    ))


@router.get("/timeline/{user_pseudo_id}")
def user_timeline(
    user_pseudo_id: str = FPath(...),
    days: int = FQuery(90, ge=1, le=365),
):
    """Full event timeline for a single user, in chronological order.
    Default window: last 90 days (covers cross-visit history).
    """
    start_suffix, end_suffix = suffix_range(days)
    query = f"""
    SELECT
      TIMESTAMP_MICROS(event_timestamp) AS ts,
      event_name,
      {EVENT_PARAMS_STRUCT}
    FROM {TABLE_GLOB}
    WHERE {SUFFIX_WHERE}
      AND user_pseudo_id = @uid
    ORDER BY event_timestamp ASC
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("start_suffix", "STRING", start_suffix),
            bigquery.ScalarQueryParameter("end_suffix", "STRING", end_suffix),
            bigquery.ScalarQueryParameter("uid", "STRING", user_pseudo_id),
        ]
    )
    rows = []
    for r in _client().query(query, job_config=job_config).result():
        p = r.p
        rows.append({
            "ts": r.ts.isoformat() if r.ts else None,
            "event_name": r.event_name,
            "session_id": p["session_id"],
            "page": p["page"],
            "tab": p["tab"],
            "video_id": p["video_id"],
            "lang": p["lang"],
            "theme": p["theme"],
            "mode": p["mode"],
            "chapter_index": p["chapter_index"],
            "chapter_title_length": p["chapter_title_length"],
            "query_length": p["query_length"],
            "word_count": p["word_count"],
            "has_question_mark": p["has_question_mark"],
            "message_length": p["message_length"],
            "format": p["format"],
            "enabled": p["enabled"],
        })
    return {"user_pseudo_id": user_pseudo_id, "rows": rows}


@router.get("/users/{user_pseudo_id}")
def user_profile(
    user_pseudo_id: str = FPath(...),
    days: int = FQuery(90, ge=1, le=365),
):
    """Cross-session profile: lifetime totals + recent sessions for one user.

    Default 90-day window so even infrequent visitors show their full history. The
    `recent_sessions` array is capped at 20 to keep the response cheap; the full
    list lives at /users/{id}/sessions with proper pagination.
    """
    start_suffix, end_suffix = suffix_range(days)
    query = f"""
    WITH events_with_session AS (
      SELECT
        event_timestamp,
        event_name,
        device.category AS device,
        device.operating_system AS os,
        device.web_info.browser AS browser,
        geo.city AS city,
        geo.region AS region,
        geo.country AS country,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'video_id') AS video_id
      FROM {TABLE_GLOB}
      WHERE {SUFFIX_WHERE}
        AND user_pseudo_id = @uid
    )
    SELECT
      COUNT(*) AS event_count,
      COUNT(DISTINCT session_id) AS session_count,
      COUNT(DISTINCT video_id) AS video_count,
      TIMESTAMP_MICROS(MIN(event_timestamp)) AS first_seen,
      TIMESTAMP_MICROS(MAX(event_timestamp)) AS last_seen,
      ARRAY_AGG(city    IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS city,
      ARRAY_AGG(region  IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS region,
      ARRAY_AGG(country IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS country,
      ARRAY_AGG(device  IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS device,
      ARRAY_AGG(os      IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS os,
      ARRAY_AGG(browser IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS browser
    FROM events_with_session
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("start_suffix", "STRING", start_suffix),
        bigquery.ScalarQueryParameter("end_suffix",   "STRING", end_suffix),
        bigquery.ScalarQueryParameter("uid", "STRING", user_pseudo_id),
    ])
    summary_row = next(iter(_client().query(query, job_config=job_config).result()), None)
    if summary_row is None or not (summary_row.event_count or 0):
        return {"user_pseudo_id": user_pseudo_id, "found": False}

    # Reuse the sessions endpoint for the recent list — single source of truth for
    # session shape, no risk of the two endpoints diverging.
    recent = sessions_list(
        days=days,
        exclude_cities="", exclude_countries="",
        hide_unknown_cities=False, hide_owner=False,
        user_pseudo_id=user_pseudo_id,
        limit=20, offset=0,
    )

    return {
        "user_pseudo_id":  user_pseudo_id,
        "found":           True,
        "event_count":     int(summary_row.event_count or 0),
        "session_count":   int(summary_row.session_count or 0),
        "video_count":     int(summary_row.video_count or 0),
        "first_seen":      summary_row.first_seen.isoformat() if summary_row.first_seen else None,
        "last_seen":       summary_row.last_seen.isoformat() if summary_row.last_seen else None,
        "city":            summary_row.city,
        "region":          summary_row.region,
        "country":         summary_row.country,
        "device":          summary_row.device,
        "os":              summary_row.os,
        "browser":         summary_row.browser,
        "is_suspected_owner": user_pseudo_id in suspected_owner_ids(),
        "recent_sessions": recent["rows"],
        "recent_sessions_has_more": recent["has_more"],
    }


@router.get("/users/{user_pseudo_id}/sessions")
def user_sessions(
    user_pseudo_id: str = FPath(...),
    days: int = FQuery(90, ge=1, le=365),
    limit: int = FQuery(50, ge=1, le=200),
    offset: int = FQuery(0, ge=0, le=10_000),
):
    """Paginated session list for one user — convenience wrapper over /sessions."""
    return sessions_list(
        days=days,
        exclude_cities="", exclude_countries="",
        hide_unknown_cities=False, hide_owner=False,
        user_pseudo_id=user_pseudo_id,
        limit=limit, offset=offset,
    )
