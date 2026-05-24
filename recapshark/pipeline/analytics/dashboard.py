"""
Local-only dashboard HTML page + parallel-fetch JSON bundle endpoint.

Owns: GET /dashboard (the analytics UI HTML, loaded by the operator at
http://localhost:8001/api/analytics/bq/dashboard) and GET /dashboard/bundle
(one-shot fan-out over overview + sessions + users + etl/runs so the UI
hydrates from a single round-trip).

The dashboard HTML lives in templates/dashboard.html (extracted from the
old inline string literal in cycle 2 commit C). Substitution is a single
{{FACETS_JSON}} marker swapped for json.dumps(facets_data) at request
time — kept intentionally lightweight to avoid pulling in Jinja for one
substitution.

Reads from: feed (facets), overview (overview), sessions_list
(sessions_list), users (users_list), filters (DEVICE_OPTIONS,
LANDED_VIA_OPTIONS), the response_cache module for the bundle's overview
+ users sub-fetches.

Imports allowed: stdlib + fastapi + sibling analytics modules + lazy
owner_routes for the etl/runs sub-fetch (kept lazy to avoid the import
cycle owner_routes ↔ analytics).
"""

import asyncio
import json
from functools import lru_cache
from pathlib import Path

from fastapi import Query as FQuery
from fastapi.responses import HTMLResponse

from . import router
from .feed import facets
from .filters import DEVICE_OPTIONS, LANDED_VIA_OPTIONS
from .overview import overview
from .sessions_list import sessions_list
from .users import users_list

_TEMPLATE_PATH = Path(__file__).parent / "templates" / "dashboard.html"
# The /facets endpoint accepts ?days=, but the dashboard HTML always loads its
# filter dropdowns over a 30-day window — narrower windows produce empty option
# lists and confuse the operator. Keep this in lock-step with the docs in
# 06_ANALYTICS.md if you ever change it.
_FACETS_DEFAULT_DAYS = 30


@lru_cache(maxsize=1)
def _template_text() -> str:
    """Read the dashboard HTML template once and cache the bytes for the
    process lifetime. The file is 93 KB; re-reading it on every dashboard
    load is wasted I/O. Single-worker uvicorn means lru_cache is enough; if
    we ever go multi-worker, each worker just builds its own cache (still
    fine — the file is read-only).
    """
    return _TEMPLATE_PATH.read_text(encoding="utf-8")


@router.get("/dashboard/bundle")
async def dashboard_bundle(
    days: int = FQuery(7, ge=1, le=365),
    exclude_cities: str = FQuery(""),
    exclude_countries: str = FQuery(""),
    hide_unknown_cities: bool = FQuery(False),
    hide_owner: bool = FQuery(False),
    sessions_limit: int = FQuery(50, ge=1, le=200),
    sessions_offset: int = FQuery(0, ge=0, le=10_000),
    users_limit: int = FQuery(100, ge=1, le=500),
    users_offset: int = FQuery(0, ge=0, le=10_000),
    source: str = FQuery("auto", pattern="^(auto|supabase|bq)$"),
    devices: str = FQuery(""),
    landed_via: str = FQuery(""),
    require_videos: bool = FQuery(False),
    require_extra_lang: bool = FQuery(False),
    require_chat: bool = FQuery(False),
):
    """Phase 8a: bundle endpoint — returns overview + sessions + users + etl in
    one HTTP call so the dashboard can render every tab from in-memory cache
    instead of fetching on demand. Sub-fetches run in parallel via
    asyncio.gather (each compute fn is sync, so we hand it to a worker thread).

    Per-section failures are isolated: if one fetch raises, the other three
    still return and the failing key carries an `{ "error": "..." }` payload.
    Frontend can render what's available and surface the error inline.
    """
    # Local import to avoid a circular load when owner_routes imports from us.
    import owner_routes as _owner

    async def _safe(fn, *args, **kwargs):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}

    overview_task = _safe(
        overview,
        days=days,
        exclude_cities=exclude_cities,
        exclude_countries=exclude_countries,
        hide_unknown_cities=hide_unknown_cities,
        hide_owner=hide_owner,
        devices=devices,
        landed_via=landed_via,
        require_videos=require_videos,
        require_extra_lang=require_extra_lang,
        require_chat=require_chat,
    )
    sessions_task = _safe(
        sessions_list,
        days=days,
        exclude_cities=exclude_cities,
        exclude_countries=exclude_countries,
        hide_unknown_cities=hide_unknown_cities,
        hide_owner=hide_owner,
        user_pseudo_id=None,
        limit=sessions_limit,
        offset=sessions_offset,
        source=source,
        devices=devices,
        landed_via=landed_via,
        require_videos=require_videos,
        require_extra_lang=require_extra_lang,
        require_chat=require_chat,
    )
    users_task = _safe(
        users_list,
        days=days,
        exclude_cities=exclude_cities,
        exclude_countries=exclude_countries,
        hide_unknown_cities=hide_unknown_cities,
        hide_owner=hide_owner,
        limit=users_limit,
        offset=users_offset,
    )
    etl_task = _safe(_owner.list_etl_runs, limit=1)

    overview_res, sessions_res, users_res, etl_res = await asyncio.gather(
        overview_task, sessions_task, users_task, etl_task,
    )
    return {
        "overview": overview_res,
        "sessions": sessions_res,
        "users": users_res,
        "etl": etl_res,
        "params": {
            "days": days,
            "exclude_cities": exclude_cities,
            "exclude_countries": exclude_countries,
            "hide_unknown_cities": hide_unknown_cities,
            "hide_owner": hide_owner,
            "sessions_limit": sessions_limit,
            "sessions_offset": sessions_offset,
            "users_limit": users_limit,
            "users_offset": users_offset,
            "source": source,
            "devices": devices,
            "landed_via": landed_via,
            "require_videos": require_videos,
            "require_extra_lang": require_extra_lang,
            "require_chat": require_chat,
        },
    }


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard():
    """BigQuery analytics dashboard HTML page.

    Loads the static template, injects the FACETS payload (city/country/
    florida-cities option lists + the device + landed_via fixed enums),
    and serves. The actual data fetching happens client-side via
    /dashboard/bundle once the HTML is parsed.
    """
    facets_data = facets(days=_FACETS_DEFAULT_DAYS)
    # Phase 4f (2026-04-22): inject the device + landed_via option lists into
    # the same FACETS payload so the dashboard can build the new filter
    # dropdowns at load time without an extra round-trip. Both are tiny fixed
    # enums (see DEVICE_OPTIONS / LANDED_VIA_OPTIONS in filters.py).
    facets_data["devices"] = list(DEVICE_OPTIONS)
    facets_data["landed_via"] = list(LANDED_VIA_OPTIONS)
    html = _template_text().replace("{{FACETS_JSON}}", json.dumps(facets_data))
    return HTMLResponse(content=html)
