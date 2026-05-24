"""
Owner-identity resolution for the dashboard's hide-owner filter.

Owns: resolved_owner_user_pseudo_ids() (confirmed owners — used in the
SQL filter), suspected_owner_ids() (confirmed=false rows — surfaced as
the yellow ⚠ chip in the UI for operator review).

Imports allowed: stdlib only at module load. supabase_owner_store is
imported LAZILY inside the helpers — keeps the BQ dashboard working
even if Supabase env vars are missing (analytics fails open, not closed).
"""

from typing import List


def resolved_owner_user_pseudo_ids() -> List[str]:
    """Effective owner-filter list = all confirmed `user_pseudo_id`s in Supabase
    `rs_owner_identities`. The legacy hardcoded list was migrated into Supabase.

    Supabase reads are TTL-cached in supabase_owner_store, so calling this on
    every request is cheap. Falls back to [] if Supabase is misconfigured — that
    means owner filtering silently no-ops rather than 500ing the whole dashboard.
    """
    try:
        # Local import to avoid a startup-time dependency on Supabase env vars
        # (so the BQ dashboard still works if Supabase isn't configured yet).
        import supabase_owner_store as _s
        return sorted(set(_s.confirmed_owner_ids()))
    except Exception:
        return []


def suspected_owner_ids() -> set:
    """Phase 1.4 helper: ids in rs_owner_identities with confirmed=false.
    Used to flag list rows (sessions, users) with the yellow ⚠ chip in the dashboard.
    Confirmed owners are filtered out at SQL time via resolved_owner_user_pseudo_ids;
    suspected ones are surfaced so the operator can confirm/revoke them.
    """
    try:
        import supabase_owner_store as _s
        return {row["user_pseudo_id"]
                for row in _s.list_owner_identities(only_confirmed=False)
                if row.get("user_pseudo_id")}
    except Exception:
        return set()
