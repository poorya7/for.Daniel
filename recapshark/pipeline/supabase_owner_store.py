"""
Supabase access for owner-identity tables (Phase 1.3).

Two tables:
  rs_owner_identities  — user_pseudo_ids that ever flagged as owner
                         (confirmed=TRUE filters them out hard;
                          confirmed=FALSE = "suspected", shown w/ yellow chip)
  rs_revoked_owner_ids — IDs the owner explicitly said "not me" — never re-add

Uses the Supabase REST API (PostgREST) directly via httpx. Adding the
supabase-py SDK would be overkill; the REST surface is one HTTP call per op.

Reads use a 60-second TTL cache so the BigQuery filter doesn't hit Supabase
on every request. Writes invalidate the cache.
"""

import time
from threading import Lock
from typing import List, Optional

import httpx

from config import supabase_url as _config_supabase_url, supabase_service_role_key


# ── env helpers ─────────────────────────────────────────────────────────────
# These are thin re-exports of the centralized config getters. Kept as
# locally-named functions because external modules already import
# `supabase_owner_store.supabase_url` (changing the import surface would
# touch more files than the config migration warrants). Phase 4b/B5
# (2026-05-08) routed the actual env read through pipeline/config.py.
def supabase_url() -> str:
    return _config_supabase_url()


def _service_key() -> str:
    return supabase_service_role_key()


def service_headers() -> dict:
    """Headers for service-role REST calls — full read/write, bypasses RLS.
    Public so other modules (etl_sessions, owner_routes) don't reach into
    underscored internals to talk to Supabase.
    """
    key = _service_key()
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


# Backwards-compat aliases — keep older callers working until we migrate them.
_supabase_url = supabase_url
_service_headers = service_headers


def is_configured() -> bool:
    return bool(supabase_url()) and bool(_service_key())


# ── tiny TTL cache for reads ────────────────────────────────────────────────
_CACHE_TTL_SEC = 60
_cache: dict = {}
_cache_lock = Lock()


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        ts, value = entry
        if time.time() - ts > _CACHE_TTL_SEC:
            _cache.pop(key, None)
            return None
        return value


def _cache_set(key: str, value):
    with _cache_lock:
        _cache[key] = (time.time(), value)


def invalidate_cache():
    with _cache_lock:
        _cache.clear()


# ── reads ───────────────────────────────────────────────────────────────────
def list_owner_identities(only_confirmed: Optional[bool] = None) -> List[dict]:
    """All rows from rs_owner_identities; optionally filter by confirmed=TRUE/FALSE."""
    if not is_configured():
        return []
    cache_key = f"identities:{only_confirmed}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    url = f"{_supabase_url()}/rest/v1/rs_owner_identities?select=*"
    if only_confirmed is True:
        url += "&confirmed=eq.true"
    elif only_confirmed is False:
        url += "&confirmed=eq.false"
    try:
        with httpx.Client(timeout=5.0) as c:
            resp = c.get(url, headers=_service_headers())
            resp.raise_for_status()
            data = resp.json() or []
    except httpx.HTTPError:
        return []
    _cache_set(cache_key, data)
    return data


def list_revoked_ids() -> List[str]:
    """All user_pseudo_ids that the owner said "not me" — never re-suspect."""
    if not is_configured():
        return []
    cache_key = "revoked"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    url = f"{_supabase_url()}/rest/v1/rs_revoked_owner_ids?select=user_pseudo_id"
    try:
        with httpx.Client(timeout=5.0) as c:
            resp = c.get(url, headers=_service_headers())
            resp.raise_for_status()
            rows = resp.json() or []
    except httpx.HTTPError:
        return []
    ids = [r["user_pseudo_id"] for r in rows if r.get("user_pseudo_id")]
    _cache_set(cache_key, ids)
    return ids


def confirmed_owner_ids() -> List[str]:
    """Convenience: only the IDs marked confirmed=TRUE — the hard-filter list."""
    rows = list_owner_identities(only_confirmed=True)
    return [r["user_pseudo_id"] for r in rows if r.get("user_pseudo_id")]


def list_owner_user_ids() -> List[str]:
    """All Supabase user UUIDs registered as owner accounts.

    These are the *stable* cross-device identifiers — unlike GA4 pseudo_ids
    they don't rotate. Used by the BigQuery owner-scan to pick up every
    pseudo_id ever associated with the owner account, including ones Safari
    ITP minted yesterday and will discard tomorrow.

    Lives in the rs_owner_user_ids table — schema is just (user_id PK, note,
    added_at). Populated manually via SQL the first time we deploy this.
    """
    if not is_configured():
        return []
    cache_key = "owner_user_ids"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    url = f"{_supabase_url()}/rest/v1/rs_owner_user_ids?select=user_id"
    try:
        with httpx.Client(timeout=5.0) as c:
            resp = c.get(url, headers=_service_headers())
            resp.raise_for_status()
            rows = resp.json() or []
    except httpx.HTTPError:
        return []
    ids = [r["user_id"] for r in rows if r.get("user_id")]
    _cache_set(cache_key, ids)
    return ids


# ── writes (service-role only) ──────────────────────────────────────────────
def upsert_identity(user_pseudo_id: str, source: str, last_seen_at: Optional[str] = None,
                    confirmed: Optional[bool] = None, notes: Optional[str] = None) -> Optional[dict]:
    """Idempotent insert of a (suspected) owner identity. Skips revoked IDs."""
    if not is_configured() or not user_pseudo_id:
        return None
    if user_pseudo_id in list_revoked_ids():
        return None
    payload: dict = {"user_pseudo_id": user_pseudo_id, "source": source}
    if last_seen_at is not None:
        payload["last_seen_at"] = last_seen_at
    if confirmed is not None:
        payload["confirmed"] = confirmed
    if notes is not None:
        payload["notes"] = notes
    url = f"{_supabase_url()}/rest/v1/rs_owner_identities?on_conflict=user_pseudo_id"
    headers = {**_service_headers(), "Prefer": "resolution=merge-duplicates,return=representation"}
    try:
        with httpx.Client(timeout=5.0) as c:
            resp = c.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json() or []
    except httpx.HTTPError:
        return None
    invalidate_cache()
    return data[0] if data else None


def confirm_identity(user_pseudo_id: str) -> Optional[dict]:
    if not is_configured() or not user_pseudo_id:
        return None
    url = f"{_supabase_url()}/rest/v1/rs_owner_identities?user_pseudo_id=eq.{user_pseudo_id}"
    try:
        with httpx.Client(timeout=5.0) as c:
            resp = c.patch(url, headers=_service_headers(), json={"confirmed": True})
            resp.raise_for_status()
            data = resp.json() or []
    except httpx.HTTPError:
        return None
    invalidate_cache()
    return data[0] if data else None


def revoke_identity(user_pseudo_id: str, reason: Optional[str] = None) -> bool:
    """Move an ID from rs_owner_identities → rs_revoked_owner_ids."""
    if not is_configured() or not user_pseudo_id:
        return False
    base = _supabase_url()
    headers = _service_headers()
    src_row: Optional[dict] = None
    try:
        with httpx.Client(timeout=5.0) as c:
            r = c.get(f"{base}/rest/v1/rs_owner_identities?user_pseudo_id=eq.{user_pseudo_id}",
                      headers=headers)
            if r.status_code == 200:
                rows = r.json() or []
                if rows:
                    src_row = rows[0]
            insert_payload = {
                "user_pseudo_id": user_pseudo_id,
                "revoked_source": (src_row or {}).get("source"),
                "reason": reason,
            }
            insert_url = f"{base}/rest/v1/rs_revoked_owner_ids?on_conflict=user_pseudo_id"
            insert_headers = {**headers, "Prefer": "resolution=merge-duplicates"}
            r2 = c.post(insert_url, headers=insert_headers, json=insert_payload)
            if r2.status_code >= 400:
                return False
            c.delete(f"{base}/rest/v1/rs_owner_identities?user_pseudo_id=eq.{user_pseudo_id}",
                     headers=headers)
    except httpx.HTTPError:
        return False
    invalidate_cache()
    return True
