"""
Owner-ID scan service
======================

Discovers owner `user_pseudo_id`s from BigQuery and upserts them into the
Supabase owner store. Lifted out of `owner_routes.py` in Phase 4a A6
(2026-05-08) so the cron worker (`etl_sessions.py`) doesn't have to reach
into a routes module just to call the scan as a Python function.

Layering after this split:
    owner_routes.py  ─┐
                      ├──>  owner_scan.py  ──>  supabase_owner_store
    etl_sessions.py  ─┘                          analytics.bq_client
                                                 analytics.filters
                                                 analytics.invalidate_response_cache

Behaviour is byte-identical: the function body, query, control flow, and
return shape are unchanged from the previous home. The only public-API
nudge is dropping the leading underscore on
`_invalidate_dashboard_cache` → `invalidate_dashboard_cache`, since it's
now imported across modules and the underscore was misleading.
"""

from google.cloud import bigquery

import supabase_owner_store as owner_store


def invalidate_dashboard_cache() -> None:
    """Drop the analytics response cache so the next /overview or /users
    read recomputes against the new owner-filter list. Lazy import dodges a
    circular module-load between the analytics package and this module's
    callers (owner_routes registers routes during analytics import).
    """
    try:
        from analytics import invalidate_response_cache
        invalidate_response_cache()
    except Exception:
        pass   # cache is a perf nicety; never fail an owner write because of it


def run_owner_scan(days: int = 30, auto_confirm: bool = False) -> dict:
    """Discover owner user_pseudo_ids from BigQuery and upsert them.

    Plain-Python entry point — no FastAPI dependency in the call signature so
    the hourly etl_sessions cron can call this directly without spinning up a
    test client. The HTTP route in owner_routes.py is a thin wrapper.

    Two signals, in order of trust:

      1. Strong  — events where `owner_user_id` event-param matches a known
                   Supabase user UUID from rs_owner_user_ids. This is the
                   stable identifier; we trust it and AUTO-CONFIRM the
                   pseudo_id (so "Hide me" filters it immediately).

      2. Weak    — events where `is_owner='true'` but no owner_user_id (older
                   sessions, or owner not logged in at event time). Upsert as
                   SUSPECTED so the operator can review with a yellow chip.

    The strong signal is what makes this design robust to Safari ITP rotating
    pseudo_ids — every new pseudo_id Safari mints for a logged-in owner gets
    auto-discovered within one scan, no manual click needed.

    `auto_confirm=True` forces ALL hits (weak + strong) to confirmed, for
    backfills. Default is per-row decision above.
    """
    # Lazy import to avoid a circular module-load between the analytics
    # subpackage and owner_routes during FastAPI router registration.
    from analytics.bq_client import _client, TABLE_GLOB
    from analytics.filters import SUFFIX_WHERE, suffix_range as _suffix_range

    start_suffix, end_suffix = _suffix_range(days)
    known_owner_user_ids = owner_store.list_owner_user_ids()

    # The query returns one row per (pseudo_id, signal) so we can act on
    # signal type per row. matched_by_user_id=TRUE means the strong signal
    # fired for this pseudo_id at least once in the window.
    query = f"""
    SELECT
      user_pseudo_id,
      MAX(event_timestamp) AS last_micros,
      LOGICAL_OR(matched_by_user_id) AS matched_by_user_id
    FROM (
      SELECT
        user_pseudo_id,
        event_timestamp,
        EXISTS (
          SELECT 1 FROM UNNEST(event_params) p
          WHERE p.key = 'owner_user_id'
            AND p.value.string_value IN UNNEST(@known_owner_user_ids)
        ) AS matched_by_user_id,
        EXISTS (
          SELECT 1 FROM UNNEST(event_params) p
          WHERE p.key = 'is_owner' AND LOWER(p.value.string_value) = 'true'
        ) AS matched_by_is_owner
      FROM {TABLE_GLOB}
      WHERE {SUFFIX_WHERE}
        AND user_pseudo_id IS NOT NULL
    )
    WHERE matched_by_user_id OR matched_by_is_owner
    GROUP BY user_pseudo_id
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("start_suffix", "STRING", start_suffix),
        bigquery.ScalarQueryParameter("end_suffix",   "STRING", end_suffix),
        bigquery.ArrayQueryParameter("known_owner_user_ids", "STRING", known_owner_user_ids),
    ])

    found, upserted, skipped_revoked, strong_hits = 0, 0, 0, 0
    revoked = set(owner_store.list_revoked_ids())
    for row in _client().query(query, job_config=job_config).result():
        found += 1
        upid = row.user_pseudo_id
        if upid in revoked:
            skipped_revoked += 1
            continue
        if row.matched_by_user_id:
            strong_hits += 1
        # last_seen_at: BQ event_timestamp is microseconds since epoch.
        last_iso = None
        try:
            from datetime import datetime, timezone
            last_iso = datetime.fromtimestamp(row.last_micros / 1_000_000, tz=timezone.utc).isoformat()
        except Exception:
            last_iso = None
        # Per-row decision: strong signal -> confirmed; weak only -> suspected
        # (unless caller forced auto_confirm for both).
        confirm_this_row = True if (auto_confirm or row.matched_by_user_id) else None
        result = owner_store.upsert_identity(
            user_pseudo_id=upid,
            source="scan_user_id" if row.matched_by_user_id else "scan",
            last_seen_at=last_iso,
            confirmed=confirm_this_row,
        )
        if result:
            upserted += 1

    if upserted:
        invalidate_dashboard_cache()
    return {
        "days": days,
        "found": found,
        "upserted": upserted,
        "skipped_revoked": skipped_revoked,
        "auto_confirmed": bool(auto_confirm),
        "known_owner_user_ids": len(known_owner_user_ids),
        "strong_signal_hits": strong_hits,
    }
