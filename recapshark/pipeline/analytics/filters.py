"""
SQL WHERE-clause builder + BigQuery query parameters + dashboard filter constants.

Owns: SUFFIX_WHERE (intraday + daily shard match), _EVENT_PARAMS_STRUCT
(single-pass event_params extraction, replaces 13 correlated subqueries —
see Phase 3.5.1), filter_where_clause(), filter_params(), csv_param(),
suffix_range(), derive_landed_via(), DEVICE_OPTIONS, LANDED_VIA_OPTIONS,
_SOCIAL_HOSTS bucket map.

Imports: stdlib + google.cloud.bigquery + owner_resolver (for the
hide_owner filter's owner-IDs param). owner_resolver is the only
internal dep; everything else is leaf.
"""

from datetime import date, timedelta
from typing import List, Optional

from google.cloud import bigquery

from .owner_resolver import resolved_owner_user_pseudo_ids


def csv_param(s: str) -> List[str]:
    return [v.strip() for v in (s or "").split(",") if v.strip()]


def suffix_range(days: int) -> tuple[str, str]:
    """Returns (start_suffix, end_suffix) as YYYYMMDD strings for _TABLE_SUFFIX pruning.
    Inclusive on both ends. days=1 means today only, days=7 means last 7 days incl. today.
    """
    days = max(1, min(int(days or 1), 365))
    end = date.today()
    start = end - timedelta(days=days - 1)
    return start.strftime("%Y%m%d"), end.strftime("%Y%m%d")


# Phase 4d — read GA4's intraday (streaming) shard alongside the daily ones.
# Today's events live in events_intraday_YYYYMMDD (streamed within minutes of
# the event); past days live in events_YYYYMMDD (finalized hours after midnight).
# Their _TABLE_SUFFIX values differ ("intraday_20260422" vs "20260422"), so the
# original BETWEEN-only filter silently dropped today's data. Use SUFFIX_WHERE
# everywhere we previously wrote that BETWEEN clause; pair with the same
# @start_suffix / @end_suffix params.
#
# Brief promotion window (~minutes around midnight UTC) can have both tables
# for the same day briefly coexisting → minor double-counting that self-corrects
# on the next ETL run. Acceptable for analytics.
SUFFIX_WHERE = """(
      _TABLE_SUFFIX BETWEEN @start_suffix AND @end_suffix
      OR _TABLE_SUFFIX = CONCAT('intraday_', @end_suffix)
    )"""


# Single-pass event_params extraction (Phase 3.5.1 refactor — Engineer 2 §6, Engineer 4 §3.7).
# Replaces 13 correlated subqueries (one per param) with one MAX-IF aggregation that walks
# event_params exactly once per row. Returns a STRUCT aliased `p`; consumers read r.p.tab,
# r.p.video_id, etc. JSON output keys are unchanged for clients.
#
# NOTE: free-form text params (video_title, chapter_title, query) are intentionally NOT
# extracted. Titles can be looked up later via video_id; for queries we only surface
# size/shape stats.
EVENT_PARAMS_STRUCT = """
      (SELECT AS STRUCT
        MAX(IF(key = 'page_location',          value.string_value, NULL)) AS page,
        MAX(IF(key = 'tab',                    value.string_value, NULL)) AS tab,
        MAX(IF(key = 'video_id',               value.string_value, NULL)) AS video_id,
        MAX(IF(key = 'selected_language',      value.string_value, NULL)) AS lang,
        MAX(IF(key = 'theme_name',             value.string_value, NULL)) AS theme,
        MAX(IF(key = 'mode',                   value.string_value, NULL)) AS mode,
        MAX(IF(key = 'chapter_index',          value.int_value,    NULL)) AS chapter_index,
        MAX(IF(key = 'chapter_title_length',   value.int_value,    NULL)) AS chapter_title_length,
        MAX(IF(key = 'query_length',           value.int_value,    NULL)) AS query_length,
        MAX(IF(key = 'word_count',             value.int_value,    NULL)) AS word_count,
        MAX(IF(key = 'has_question_mark',      value.string_value, NULL)) AS has_question_mark,
        MAX(IF(key = 'message_length',         value.int_value,    NULL)) AS message_length,
        MAX(IF(key = 'format',                 value.string_value, NULL)) AS format,
        MAX(IF(key = 'enabled',                value.string_value, NULL)) AS enabled,
        MAX(IF(key = 'ga_session_id',          value.int_value,    NULL)) AS session_id,
        MAX(IF(key = 'is_owner',               value.string_value, NULL)) AS is_owner,
        MAX(IF(key = 'owner_source',           value.string_value, NULL)) AS owner_source
      FROM UNNEST(event_params)) AS p
"""


def filter_where_clause():
    """SQL WHERE fragment driven by query parameters.
    Includes _TABLE_SUFFIX pruning so we never scan more days than requested,
    and matches the intraday shard so today's activity shows up live.
    """
    return f"""
      {SUFFIX_WHERE}
      AND (ARRAY_LENGTH(@exclude_cities) = 0 OR geo.city NOT IN UNNEST(@exclude_cities))
      AND (ARRAY_LENGTH(@exclude_countries) = 0 OR geo.country NOT IN UNNEST(@exclude_countries))
      AND (NOT @hide_unknown_cities OR (geo.city IS NOT NULL AND geo.city != '(not set)' AND geo.city != ''))
      AND (NOT @hide_owner OR user_pseudo_id NOT IN UNNEST(@owner_user_pseudo_ids))
    """


def filter_params(exclude_cities: str, exclude_countries: str, hide_unknown_cities: bool, hide_owner: bool, days: int):
    start_suffix, end_suffix = suffix_range(days)
    return [
        bigquery.ScalarQueryParameter("start_suffix", "STRING", start_suffix),
        bigquery.ScalarQueryParameter("end_suffix", "STRING", end_suffix),
        bigquery.ArrayQueryParameter("exclude_cities", "STRING", csv_param(exclude_cities)),
        bigquery.ArrayQueryParameter("exclude_countries", "STRING", csv_param(exclude_countries)),
        bigquery.ScalarQueryParameter("hide_unknown_cities", "BOOL", bool(hide_unknown_cities)),
        bigquery.ScalarQueryParameter("hide_owner", "BOOL", bool(hide_owner)),
        bigquery.ArrayQueryParameter("owner_user_pseudo_ids", "STRING", resolved_owner_user_pseudo_ids()),
    ]


# Traffic-source bucketing lives in `pipeline.traffic_source` (leaf module
# also imported by etl_sessions). Re-exported here so existing analytics
# callers (`from .filters import derive_landed_via`) keep working.
from traffic_source import derive_landed_via, SOCIAL_HOSTS as _SOCIAL_HOSTS  # noqa: F401


# Hardcoded option lists for the new device + landed-via filter dropdowns.
# Both are small fixed enums — no need to query Supabase or BQ to build them.
# Devices: GA4's device.category values (mobile/desktop/tablet); 'other' covers
# the rare smart-tv / set-top entries we've seen in the wild.
DEVICE_OPTIONS = ["mobile", "desktop", "tablet", "other"]
LANDED_VIA_OPTIONS = ["direct", "search", "social", "referral", "other"]
