"""
Tiny in-memory TTL response cache for the dashboard hot endpoints.

Owns: _response_cache dict + lock + TTL constant + get/set helpers + the
public invalidate hook (called by owner write endpoints in owner_routes.py).

Imports allowed: stdlib only. Leaf module — no internal-package imports.
"""

import time
from threading import Lock

# ── Phase 4c: tiny in-memory response cache ────────────────────────────────
# Only on hot endpoints (/overview, /users) — sessions paths already get caching
# via supabase_sessions_store. TTL is intentionally short (60s) so confirm/revoke/
# rescan actions are reflected within a minute even without explicit invalidation.
# Owner write endpoints in owner_routes.py also call invalidate_response_cache()
# directly so the dashboard doesn't show stale numbers immediately after a click.
_RESPONSE_CACHE_TTL_SEC = 60
_response_cache: dict = {}
_response_cache_lock = Lock()


def cached_response(key: str, fn):
    with _response_cache_lock:
        entry = _response_cache.get(key)
        if entry and (time.time() - entry[0]) < _RESPONSE_CACHE_TTL_SEC:
            return entry[1]
    value = fn()
    with _response_cache_lock:
        _response_cache[key] = (time.time(), value)
    return value


def invalidate_response_cache() -> None:
    """Drop all cached responses. Called by owner write endpoints so the next
    /overview or /users read recomputes against the new owner-filter list."""
    with _response_cache_lock:
        _response_cache.clear()
