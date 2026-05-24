"""
Read access to rs_chat_messages (Phase 5d).

ETL calls `fetch_for_window(start_date, end_date)` once per run and gets back
{(user_pseudo_id, ga_session_id): [messages...]} so the narrative builder can
inline real chat questions.

Same conservative pattern as supabase_sessions_store: bulk fetch the whole
window, group in Python. At our scale (a few hundred chat messages per fortnight)
this is much simpler than per-session round-trips.
"""

from __future__ import annotations

from datetime import date
from typing import List

import httpx

import supabase_owner_store as _owner


_HARD_CAP = 10_000   # >>> realistic per-fortnight chat volume; defends against runaways


def fetch_for_window(start_date: date, end_date: date) -> dict[tuple[str, int], list[dict]]:
    """All chat messages with `sent_at` in [start_date, end_date+1day) UTC.

    Returns a dict keyed by (user_pseudo_id, ga_session_id) so callers can do
    a O(1) lookup per session row. Messages within each bucket are sorted oldest-first
    (the order they were asked) so the narrative reads naturally.

    Falls back to {} on any error so a Supabase outage doesn't block ETL — sessions
    still get narratives, just without the chat-text enrichment.
    """
    if not _owner.is_configured():
        return {}
    next_day = date.fromordinal(end_date.toordinal() + 1)
    url = (
        f"{_owner.supabase_url()}/rest/v1/rs_chat_messages"
        f"?select=user_pseudo_id,ga_session_id,sent_at,message"
        f"&sent_at=gte.{start_date.isoformat()}T00:00:00Z"
        f"&sent_at=lt.{next_day.isoformat()}T00:00:00Z"
        f"&order=sent_at.asc"
    )
    headers = {
        **_owner.service_headers(),
        "Range-Unit": "items",
        "Range": f"0-{_HARD_CAP - 1}",
    }
    try:
        with httpx.Client(timeout=15.0) as c:
            resp = c.get(url, headers=headers)
            if resp.status_code >= 400:
                return {}
            rows: List[dict] = resp.json() or []
    except httpx.HTTPError:
        return {}

    grouped: dict[tuple[str, int], list[dict]] = {}
    for r in rows:
        uid = r.get("user_pseudo_id")
        sid = r.get("ga_session_id")
        if not uid or sid is None:
            continue   # orphan row — was logged before we knew the session_id
        key = (uid, int(sid))
        grouped.setdefault(key, []).append({
            "sent_at": r.get("sent_at"),
            "message": r.get("message") or "",
        })
    return grouped
