"""
Paginated session list endpoint.

Owns: GET /sessions plus the two implementation paths it delegates to —
_sessions_list_from_supabase (preferred, reads rs_sessions, applies filters
in Python) and the inline BQ-direct query in sessions_list() (fallback when
?source=bq is forced or Supabase blips). Also owns _enrich_session_rows,
which mutates rows in place to attach video titles + chat counts/messages.

Reads from: bq_client (_client, TABLE_GLOB), filters (filter_where_clause,
filter_params, csv_param, derive_landed_via),
_session_filter (build_keep_predicate, compute_chat_count_map),
owner_resolver (resolved_owner_user_pseudo_ids, suspected_owner_ids),
pagination (paginate).

Imports allowed: stdlib + typing + fastapi + google.cloud.bigquery + sibling
analytics modules + lazy supabase_sessions_store / chat_messages_store /
video_titles / narrative at call time.
"""

from datetime import date, timedelta
from typing import Optional

from fastapi import Query as FQuery
from google.cloud import bigquery

from . import router
from .bq_client import _client, TABLE_GLOB
from .filters import (
    csv_param,
    filter_where_clause,
    filter_params,
    derive_landed_via,
)
from ._session_filter import (
    build_keep_predicate,
    compute_chat_count_map,
)
from .owner_resolver import resolved_owner_user_pseudo_ids, suspected_owner_ids
from .pagination import paginate


def _sessions_list_from_supabase(
    days: int,
    exclude_cities: str,
    exclude_countries: str,
    hide_unknown_cities: bool,
    hide_owner: bool,
    user_pseudo_id: Optional[str],
    limit: int,
    offset: int,
    devices: str = "",
    landed_via: str = "",
    require_videos: bool = False,
    require_extra_lang: bool = False,
    require_chat: bool = False,
) -> dict:
    """Phase 4b: read sessions from rs_sessions instead of BigQuery.

    Filtering happens in Python after a single windowed fetch — see the rationale
    in supabase_sessions_store. Owner exclusion uses the same Supabase-confirmed
    list as the BQ path so the two sources are interchangeable.

    Today's data may be missing if the nightly ETL hasn't run yet — that gap
    closes when Phase 4d schedules the cron. For now the operator can hit
    POST /etl/sessions/run on demand. Callers wanting a guaranteed-fresh read
    can pass ?source=bq to force the original BigQuery path.

    Phase 4f (2026-04-22): added `devices` + `landed_via` filters. Both are
    CSV multi-select; empty string means "all" (no filter applied). landed_via
    has a per-row fallback derivation when the rs_sessions column is NULL
    (sessions older than the migration).
    """
    import supabase_sessions_store as _s

    end = date.today()
    start = end - timedelta(days=max(1, min(int(days or 1), 365)) - 1)
    rows = _s.fetch_sessions_window(start, end)

    suspected = suspected_owner_ids()
    chat_count_map = compute_chat_count_map(start, end, enabled=require_chat)

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
        chat_count_map=chat_count_map,
        user_pseudo_id_filter=user_pseudo_id,
    )

    filtered = [r for r in rows if _keep(r)]   # already started_at desc from PostgREST
    page = filtered[offset:offset + limit + 1]

    out = []
    for r in page[:limit]:
        # landed_via falls back to the on-the-fly derivation for rows that
        # predate the 2026-04-22 migration (column will be NULL for those).
        # video_lang has no fallback — historical sessions never fired the
        # video_lang_detected event, so it just stays empty on the card.
        landed = r.get("landed_via") or derive_landed_via(
            r.get("traffic_medium"), r.get("traffic_source"),
        )
        out.append({
            "user_pseudo_id":   r.get("user_pseudo_id"),
            "session_id":       r.get("session_id"),
            "started_at":       r.get("started_at"),
            "ended_at":         r.get("ended_at"),
            "duration_sec":     int(r.get("duration_sec") or 0),
            "event_count":      int(r.get("event_count") or 0),
            "page_view_count":  int(r.get("page_view_count") or 0),
            "landing_page":     r.get("landing_page"),
            "exit_page":        r.get("exit_page"),
            "video_ids":        list(r.get("video_ids") or []),
            "languages_used":   list(r.get("languages_used") or []),
            "city":             r.get("city"),
            "region":           r.get("region"),
            "country":          r.get("country"),
            "device":           r.get("device"),
            "os":               r.get("os"),
            "browser":          r.get("browser"),
            "traffic_source":   r.get("traffic_source"),
            "traffic_medium":   r.get("traffic_medium"),
            "landed_via":       landed,
            "video_lang":       r.get("video_lang"),
            "narrative":        r.get("narrative"),
            "is_suspected_owner": r.get("user_pseudo_id") in suspected,
        })
    _enrich_session_rows(out, start, end)
    has_more = len(page) > limit
    return {
        "rows": out,
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
        "next_offset": (offset + limit) if has_more else None,
        "count": len(out),
        "source": "supabase",
    }


def _enrich_session_rows(rows: list, start: date, end: date) -> None:
    """Mutate `rows` in place to attach two display-only fields the dashboard
    needs but the base session record doesn't carry:

      - `video_titles`: dict {video_id: {"title", "channel"}} so the bottom-row
        chip can show the actual video name next to the link instead of the
        opaque YouTube ID. Pulled from the rs_video_titles cache (no oEmbed
        round-trip on the dashboard hot path — anything not cached just renders
        as the bare ID, and the next ETL run will fill it in).
      - `chat_count`: int, how many chat questions this session sent. Computed
        from rs_chat_messages, scoped to the same date window as the session
        page so we don't pull the entire history per request.
      - `chat_messages`: list[{"sent_at", "message"}] — the raw chat questions
        for this session, oldest-first. Same Supabase round-trip as `chat_count`,
        so attaching the messages here is free. Used by the dashboard to expand
        an inline panel when the user clicks the "N chat" chip.

    Both lookups are batched (one Supabase round-trip each per dashboard page)
    and any failure is swallowed — chips just don't appear, the rest of the
    card renders normally.
    """
    if not rows:
        return
    try:
        import video_titles as _titles
        all_ids = sorted({v for r in rows for v in (r.get("video_ids") or []) if v})
        title_map = _titles.resolve_many(all_ids) if all_ids else {}
    except Exception:
        title_map = {}
    try:
        import chat_messages_store as _chat
        chat_grouped = _chat.fetch_for_window(start, end)
    except Exception:
        chat_grouped = {}
    for r in rows:
        vids = r.get("video_ids") or []
        r["video_titles"] = {
            v: title_map[v]
            for v in vids
            if title_map.get(v)   # drop None entries (unresolved/not_found)
        }
        sid = r.get("session_id")
        try:
            sid_int = int(sid) if sid is not None else None
        except (TypeError, ValueError):
            sid_int = None
        key = (r.get("user_pseudo_id"), sid_int) if sid_int is not None else None
        msgs = chat_grouped.get(key, []) if key else []
        r["chat_count"] = len(msgs)
        r["chat_messages"] = msgs


@router.get("/sessions")
def sessions_list(
    days: int = FQuery(7, ge=1, le=365),
    exclude_cities: str = FQuery(""),
    exclude_countries: str = FQuery(""),
    hide_unknown_cities: bool = FQuery(False),
    hide_owner: bool = FQuery(False),
    user_pseudo_id: Optional[str] = FQuery(None),
    limit: int = FQuery(50, ge=1, le=200),
    offset: int = FQuery(0, ge=0, le=10_000),
    source: str = FQuery("auto", pattern="^(auto|supabase|bq)$"),
    devices: str = FQuery("", description="CSV: mobile,desktop,tablet,other. Empty=all."),
    landed_via: str = FQuery("", description="CSV: direct,search,social,referral,other. Empty=all."),
    require_videos: bool = FQuery(False, description="Drop sessions with empty video_ids."),
    require_extra_lang: bool = FQuery(False, description="Drop sessions whose only language equals video_lang."),
    require_chat: bool = FQuery(False, description="Drop sessions with no chat messages."),
):
    """Paginated session list (newest first), respecting all dashboard filters.

    Phase 4b: defaults to reading from the precomputed rs_sessions table for
    speed (and to keep BQ scan costs near zero on dashboard navigation). Pass
    `?source=bq` to force the live-from-BigQuery path — useful for spot-checking
    fresh data the ETL hasn't picked up yet, or if Supabase reads ever break.

    Each row aggregates a single (user_pseudo_id, ga_session_id) bucket:
      - started_at / ended_at / duration_sec
      - event_count, page_view_count
      - first/last page seen
      - distinct video_ids touched (array)
      - latest geo + device (deterministic via ARRAY_AGG ORDER BY ts DESC)

    Optional `?user_pseudo_id=` narrows to one user, which is what
    /users/{id}/sessions delegates to under the hood.
    """
    if source != "bq":
        try:
            import supabase_sessions_store as _s
            if _s.is_configured():
                return _sessions_list_from_supabase(
                    days, exclude_cities, exclude_countries,
                    hide_unknown_cities, hide_owner,
                    user_pseudo_id, limit, offset,
                    devices=devices, landed_via=landed_via,
                    require_videos=require_videos,
                    require_extra_lang=require_extra_lang,
                    require_chat=require_chat,
                )
        except Exception:
            # Auto mode falls back to BQ on any Supabase read failure so the dashboard
            # never goes blank because of a transient PostgREST hiccup.
            if source == "supabase":
                raise

    extra_filter = "AND user_pseudo_id = @uid" if user_pseudo_id else ""
    query = f"""
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
        COALESCE(collected_traffic_source.manual_source, traffic_source.source) AS ts_source,
        COALESCE(collected_traffic_source.manual_medium, traffic_source.medium) AS ts_medium,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'video_id') AS video_id,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'video_lang') AS video_lang
      FROM {TABLE_GLOB}
      WHERE {filter_where_clause()}
        AND user_pseudo_id IS NOT NULL
        {extra_filter}
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
      ARRAY_AGG(DISTINCT video_id IGNORE NULLS) AS video_ids,
      ARRAY_AGG(city    IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS city,
      ARRAY_AGG(region  IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS region,
      ARRAY_AGG(country IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS country,
      ARRAY_AGG(device  IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS device,
      ARRAY_AGG(os      IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS os,
      ARRAY_AGG(browser IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS browser,
      ARRAY_AGG(ts_source  IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS traffic_source,
      ARRAY_AGG(ts_medium  IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS traffic_medium,
      ARRAY_AGG(video_lang IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS video_lang
    FROM events_with_session
    WHERE session_id IS NOT NULL
    GROUP BY user_pseudo_id, session_id
    ORDER BY started_at DESC
    LIMIT @limit OFFSET @offset
    """
    params = [
        *filter_params(exclude_cities, exclude_countries, hide_unknown_cities, hide_owner, days),
        bigquery.ScalarQueryParameter("limit", "INT64", limit + 1),
        bigquery.ScalarQueryParameter("offset", "INT64", offset),
    ]
    if user_pseudo_id:
        params.append(bigquery.ScalarQueryParameter("uid", "STRING", user_pseudo_id))
    job_config = bigquery.QueryJobConfig(query_parameters=params)

    suspected = suspected_owner_ids()
    # Lazy import: keep narrative module out of the BQ path's import cost when
    # Supabase is serving (the common case).
    import narrative as _narr

    # Post-query filter: city / country / hide_owner / hide_unknown_cities are
    # already pushed into the SQL WHERE via filter_where_clause/filter_params,
    # so we leave those knobs unset here and only re-check the column-level
    # ones (devices, landed_via, require_videos/extra_lang/chat) in Python.
    _bq_end = date.today()
    _bq_start = _bq_end - timedelta(days=max(1, min(int(days or 1), 365)) - 1)
    _bq_keep = build_keep_predicate(
        keep_devices={d.lower() for d in csv_param(devices) if d},
        keep_landed={v.lower() for v in csv_param(landed_via) if v},
        require_videos=require_videos,
        require_extra_lang=require_extra_lang,
        require_chat=require_chat,
        chat_count_map=compute_chat_count_map(_bq_start, _bq_end, enabled=require_chat),
    )

    raw_rows = []
    for r in _client().query(query, job_config=job_config).result():
        ts_source = getattr(r, "traffic_source", None)
        ts_medium = getattr(r, "traffic_medium", None)
        landed = derive_landed_via(ts_medium, ts_source)
        row = {
            "user_pseudo_id":   r.user_pseudo_id,
            "session_id":       r.session_id,
            "started_at":       r.started_at.isoformat() if r.started_at else None,
            "ended_at":         r.ended_at.isoformat() if r.ended_at else None,
            "duration_sec":     int(r.duration_sec or 0),
            "event_count":      int(r.event_count or 0),
            "page_view_count":  int(r.page_view_count or 0),
            "landing_page":     r.landing_page,
            "exit_page":        r.exit_page,
            "video_ids":        list(r.video_ids or []),
            "languages_used":   [],   # BQ-list path doesn't aggregate; falls back to empty
            "city":             r.city,
            "region":           r.region,
            "country":          r.country,
            "device":           r.device,
            "os":               r.os,
            "browser":          r.browser,
            "traffic_source":   ts_source,
            "traffic_medium":   ts_medium,
            "landed_via":       landed,
            "video_lang":       getattr(r, "video_lang", None),
            "is_suspected_owner": r.user_pseudo_id in suspected,
        }
        # Post-query filters (consistent with the supabase path; the BQ-direct
        # fallback is rare enough that pushing these into the SQL WHERE isn't
        # worth the complexity).
        if not _bq_keep(row):
            continue
        # Phase 5a: BQ path doesn't carry raw_events on the list endpoint, so
        # the narrative built here will skip tab-dwell + chat-count clauses.
        # That's intentional — those need raw_events, which only the Supabase
        # path (and the per-session detail endpoint) hydrate. Result is still
        # a useful one-liner: "Arrived 5pm from Milan on desktop / Windows.
        # Pasted video xyz. Left after 4m." Good enough for the rare BQ-fallback case.
        row["narrative"] = _narr.build(row)
        raw_rows.append(row)
    out = paginate(raw_rows, limit, offset)
    # Page-scope window for chat lookup mirrors the supabase path's range.
    end = date.today()
    start = end - timedelta(days=max(1, min(int(days or 1), 365)) - 1)
    _enrich_session_rows(out.get("rows") or [], start, end)
    out["source"] = "bq"
    return out
