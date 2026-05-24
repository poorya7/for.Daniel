# pipeline/analytics/

Admin analytics dashboard subpackage. Reads GA4 event data from BigQuery + cached aggregates from Supabase (`rs_sessions` table), serves the `/api/analytics/bq/*` routes consumed by the admin dashboard at `/api/analytics/bq/dashboard`.

**Status:** active — populated by cycle 2 of the SRP refactor on 2026-05-06 (file inventory in `docs/_tech/01_ARCHITECTURE.md`, durable lessons in `docs/_tech/REFACTORING_LESSONS.md`). Imported by `pipeline/routes.py` for the FastAPI mount; the original `pipeline/bq_analytics_routes.py` was deleted as part of the same cycle.

## Data flow

```
Browser → /api/analytics/bq/* (router declared in __init__.py)
   ↓
   endpoint modules (overview.py / users.py / sessions_list.py / session_detail.py / feed.py / dashboard.py)
   ↓
   shared infra (filters.py + owner_resolver.py + pagination.py + response_cache.py)
   ↓
   data sources (Supabase rs_sessions for fast paths + BigQuery for raw event slices)
```

The shared `APIRouter(prefix="/analytics/bq", ...)` lives in `__init__.py`; importing the package triggers each endpoint module to register its `@router.get(...)` handlers on that one instance — so there's no separate `routes.py` aggregator.

## Per-file responsibilities

| File | Owns |
|---|---|
| `__init__.py` | Declares the shared router + re-exports `invalidate_response_cache`; importing the package triggers every endpoint module to register its routes. |
| `overview.py` | `/overview` — hero stats (Supabase-first, BQ fallback). |
| `users.py` | `/users`, `/timeline/{uid}`, `/users/{uid}` (profile), `/users/{uid}/sessions`. |
| `sessions_list.py` | `/sessions` — filtered session list + `_enrich_session_rows` (video titles + chat counts/messages). |
| `session_detail.py` | `/sessions/{uid}/{sid}` — per-session event timeline. |
| `dashboard.py` | `/dashboard` (HTML page) + `/dashboard/bundle` (parallel-fetch wrapper). |
| `templates/dashboard.html` | Extracted dashboard HTML/CSS/JS (was a 2,250-LOC inline string in the original file). |
| `feed.py` | `/feed` (live event feed) + `/facets` (filter-dropdown option lists). |
| `bq_client.py` | Lazy BigQuery client + project/dataset/table-glob constants. |
| `filters.py` | `SUFFIX_WHERE` + `EVENT_PARAMS_STRUCT` + filter helpers (csv_param, suffix_range, filter_where_clause, filter_params, derive_landed_via, DEVICE_OPTIONS, LANDED_VIA_OPTIONS). |
| `owner_resolver.py` | Resolves "hide owner" filter to concrete `user_pseudo_id` list (Supabase confirmed + suspected). |
| `pagination.py` | `paginate()` page slicing + `row_to_event()` shape converter. |
| `response_cache.py` | 60-sec TTL response cache + `invalidate_response_cache()` (called by any write that affects analytics). |

## Cache invalidation contract

Any code path that writes to data the dashboard reads (e.g., a new session lands, owner-list updates) MUST call `invalidate_response_cache()` after the write commits. Otherwise the dashboard will serve stale aggregates until the next TTL flush.

## How to add a new endpoint

1. Pick the right endpoint file (or create a new one if it's a new domain — e.g., `retention.py` for retention-cohort analysis).
2. Add the compute function (e.g., `_retention_compute(...)`) and decorate the route handler with `@router.get(...)` (import `router` from the package).
3. If the file is new, register it in `__init__.py` so importing the package triggers its decorator (e.g., `from . import retention  # noqa: F401`).
4. Wrap hot reads in `cached_response("retention:...", lambda: _retention_compute(...))` from `response_cache.py`.
5. If the new endpoint surfaces in the dashboard UI, add it to the appropriate tab in `templates/dashboard.html`.
6. If the endpoint depends on filters, reuse `filter_where_clause()` + `filter_params()` from `filters.py` — don't duplicate WHERE-clause logic.
