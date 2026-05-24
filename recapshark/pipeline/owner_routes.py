"""
Owner identity routes — Phases 1.2 and 1.3.

Phase 1.2 (auth):
  GET  /me                                            → who is the caller
Phase 1.3 (owner ID learning, semi-manual):
  GET  /analytics/bq/owners                           → list known + revoked IDs
  POST /analytics/bq/owners/scan                      → discover owner IDs from BQ
  POST /analytics/bq/owners/{user_pseudo_id}/confirm  → ✅ definitely me, hide hard
  POST /analytics/bq/owners/{user_pseudo_id}/revoke   → ❌ not me, never re-suspect

JWT validation: forward the bearer token to Supabase /auth/v1/user and trust the
200/401. One HTTP roundtrip per call — fine since neither /me nor the mutation
routes are hot paths.

Auth layering (Phase-1 cleanup, 2026-05-07):
  * GET routes  → guarded by the global X-API-Token middleware in server.py.
                  That's enough — they're read-only.
  * POST routes → ALSO require a valid Supabase owner JWT via
                  Depends(require_owner_jwt). The static token is bundle-
                  extractable; JWT proves the caller is actually signed in to
                  the owner Supabase account. Defense in depth.

Cron note: etl_sessions.py calls run_owner_scan() as a plain Python function,
not through HTTP, so the JWT requirement on POST /scan does not affect the
nightly job. Manual curl invocations now need a real owner access_token in the
Authorization header (grab one from the dashboard's localStorage).
"""

import os
from typing import Optional

import httpx
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path as FPath, Query as FQuery

import supabase_owner_store as owner_store
from owner_scan import run_owner_scan, invalidate_dashboard_cache
from config import supabase_url as _supabase_url, supabase_anon_key as _supabase_anon_key

router = APIRouter()

# Match the email used when creating the Supabase auth user. Env-driven so the
# admin identity can change without a code edit.
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "owner@example.com")


def _verify_owner_jwt(authorization: Optional[str]) -> dict:
    """Validate `Authorization: Bearer <jwt>` against Supabase Auth.

    Returns a dict shaped like:
      {"is_owner": bool, "email": str|None, "user_id": str|None,
       "reason": str|None}
    `reason` is set on hard failures (no header, supabase down, non-200 from
    Supabase, wrong email) to make it easy to log/debug. Callers in /me return
    the dict as-is; the require_owner_jwt dependency turns failures into 401s.
    """
    base = _supabase_url()
    apikey = _supabase_anon_key()
    if not base or not apikey:
        return {"is_owner": False, "reason": "supabase_not_configured"}

    if not authorization or not authorization.lower().startswith("bearer "):
        return {"is_owner": False, "reason": "missing_bearer"}

    token = authorization.split(" ", 1)[1].strip()
    if not token:
        return {"is_owner": False, "reason": "empty_bearer"}

    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(
                f"{base}/auth/v1/user",
                headers={
                    "apikey": apikey,
                    "Authorization": f"Bearer {token}",
                },
            )
    except httpx.HTTPError:
        return {"is_owner": False, "reason": "supabase_unreachable"}

    if resp.status_code != 200:
        return {"is_owner": False, "reason": f"supabase_status_{resp.status_code}"}

    data = resp.json() or {}
    email = (data.get("email") or "").lower()
    is_owner = email == OWNER_EMAIL.lower()
    return {
        "is_owner": is_owner,
        "email": email,
        "user_id": data.get("id"),
        "reason": None if is_owner else "not_owner_email",
    }


def require_owner_jwt(authorization: Optional[str] = Header(default=None)) -> dict:
    """FastAPI dependency: hard-fails with 401 if the caller isn't the owner.

    Use on every owner-mutation route (POST). The X-API-Token middleware still
    runs in front of this — both layers must pass for the request to reach the
    handler. That's the "static-token + per-session JWT" double lock.
    """
    info = _verify_owner_jwt(authorization)
    if not info["is_owner"]:
        raise HTTPException(
            status_code=401,
            detail=f"owner_jwt_required: {info.get('reason') or 'unauthorized'}",
        )
    return info


@router.get("/me")
def me(authorization: Optional[str] = Header(default=None)):
    """Return owner status for the caller, derived from their Supabase JWT."""
    info = _verify_owner_jwt(authorization)
    if info.get("reason") == "supabase_not_configured":
        return {"is_owner": False, "reason": "supabase_not_configured"}
    if info.get("reason") == "supabase_unreachable":
        return {"is_owner": False, "reason": "supabase_unreachable"}
    return {
        "is_owner": info["is_owner"],
        "email": info.get("email") or "",
        "user_id": info.get("user_id"),
        "source": "supabase_auth",
    }


# ── Phase 1.3: owner-ID learning ────────────────────────────────────────────

@router.get("/analytics/bq/owners")
def list_owners():
    """Snapshot of what the dashboard knows about owner identities."""
    return {
        "configured": owner_store.is_configured(),
        "identities": owner_store.list_owner_identities(),
        "revoked": owner_store.list_revoked_ids(),
    }


# `run_owner_scan()` lives in `owner_scan.py` since Phase 4a A6 (2026-05-08)
# so cron (etl_sessions.py) doesn't have to import a routes module to call
# it. This file imports it at the top and exposes the HTTP wrapper below.


@router.post("/analytics/bq/owners/scan")
def scan_owners(
    days: int = FQuery(30, ge=1, le=365),
    auto_confirm: bool = FQuery(False),
    _owner: dict = Depends(require_owner_jwt),
):
    """HTTP wrapper around run_owner_scan() — see that function for semantics.
    Cron jobs call run_owner_scan() directly (no HTTP, no JWT). This route is
    only for ad-hoc manual invocation by the owner.
    """
    return run_owner_scan(days=days, auto_confirm=auto_confirm)


# `_invalidate_dashboard_cache()` moved to owner_scan.py (renamed to
# `invalidate_dashboard_cache`) in Phase 4a A6 (2026-05-08) so both
# owner_scan and the route handlers below share one definition.


@router.post("/analytics/bq/owners/{user_pseudo_id}/confirm")
def confirm_owner(
    user_pseudo_id: str = FPath(...),
    _owner: dict = Depends(require_owner_jwt),
):
    """✅ Mark a suspected ID as definitely the owner. Hides their history from the dashboard."""
    row = owner_store.confirm_identity(user_pseudo_id)
    invalidate_dashboard_cache()
    return {"ok": bool(row), "row": row}


@router.post("/analytics/bq/owners/{user_pseudo_id}/revoke")
def revoke_owner(
    user_pseudo_id: str = FPath(...),
    body: Optional[dict] = Body(default=None),
    _owner: dict = Depends(require_owner_jwt),
):
    """❌ "Not me" — moves the ID into rs_revoked_owner_ids so future scans skip it."""
    reason = (body or {}).get("reason") if isinstance(body, dict) else None
    ok = owner_store.revoke_identity(user_pseudo_id, reason=reason)
    invalidate_dashboard_cache()
    return {"ok": ok}


# ─────────────────────────────────────────────────────────────────────────────
# Phase 4 — sessions ETL trigger
# ─────────────────────────────────────────────────────────────────────────────
# Manual trigger for now. In production this will be invoked nightly by cron
# (DigitalOcean droplet) or by a scheduled Supabase function. Living here for
# admin convenience; we'll move to a dedicated etl_routes module if more ETL
# jobs land.

@router.post("/analytics/bq/etl/sessions/run")
def trigger_sessions_etl(
    days: int = FQuery(2, ge=1, le=90),
    _owner: dict = Depends(require_owner_jwt),
):
    """Run the BQ→Supabase sessions ETL synchronously and return a summary.
    Default `days=2` is the nightly window (yesterday + day-before, to catch
    sessions spanning midnight). Bump this for one-time backfills.

    Cron path: PM2 calls etl_sessions.run() directly (no HTTP), so the JWT
    requirement here only affects ad-hoc curl/dashboard manual triggers.
    """
    import etl_sessions
    return etl_sessions.run(days)


@router.get("/analytics/bq/etl/runs")
def list_etl_runs(limit: int = FQuery(20, ge=1, le=200)):
    """Recent ETL runs — feeds the "Last ETL: 2h ago ✅" badge in the dashboard footer.
    Shape mirrors the rs_etl_runs table 1:1.
    """
    if not owner_store.is_configured():
        return {"rows": []}
    url = (f"{owner_store._supabase_url()}/rest/v1/rs_etl_runs"
           f"?select=*&order=started_at.desc&limit={int(limit)}")
    try:
        with httpx.Client(timeout=5.0) as c:
            resp = c.get(url, headers=owner_store._service_headers())
            resp.raise_for_status()
            rows = resp.json() or []
    except httpx.HTTPError as e:
        return {"rows": [], "error": str(e)}
    return {"rows": rows}
