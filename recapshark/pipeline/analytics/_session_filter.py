"""Shared session-filter logic for the analytics dashboard.

Consolidates the three near-identical `_keep(r)` predicates that lived in
`sessions_list.py:103-146` (Supabase path), `sessions_list.py:414-436`
(BQ-direct fallback), and `overview.py:73-108` (hero-stats path) before
Phase 4e. Each call site now goes through `build_keep_predicate(...)` and
`compute_chat_count_map(...)`.

The helper is **filter-only**. Pre-query knobs that the SQL WHERE already
handles in the BQ path (city/country exclude lists, owner exclusion) are
passed as empty values for that path so the corresponding branches no-op
— same predicate, different inputs.

API:
  - `build_keep_predicate(...)`        → returns `(row: dict) -> bool`
  - `compute_chat_count_map(start, end, *, enabled)` → `{(uid, sid): n}`
  - `resolve_landed_via(row)`          → precomputed-or-derived fallback
"""

from datetime import date
from typing import Callable, Optional

from .filters import DEVICE_OPTIONS, derive_landed_via


def resolve_landed_via(row: dict) -> Optional[str]:
    """Prefer the ETL-precomputed `landed_via` column on the row; fall back
    to deriving it on the fly so old rows (pre-2026-04-22 migration) still
    respect the filter and render correctly on the card."""
    v = row.get("landed_via")
    if v:
        return str(v).lower()
    return derive_landed_via(row.get("traffic_medium"), row.get("traffic_source"))


def compute_chat_count_map(start: date, end: date, *, enabled: bool) -> dict:
    """Single-batch fetch of (user_pseudo_id, session_id) → chat-count for
    a date window. Returns `{}` when disabled or on any failure (silent —
    require_chat filters out everything in that case, which is the safer
    default than crashing the dashboard)."""
    if not enabled:
        return {}
    try:
        import chat_messages_store as _chat
        return {k: len(v) for k, v in _chat.fetch_for_window(start, end).items()}
    except Exception:
        return {}


def _row_session_key(row: dict):
    """Build the (uid, sid_int) tuple used to look a row up in
    chat_count_map. Returns None when sid can't coerce to int (rare)."""
    sid = row.get("session_id")
    try:
        sid_int = int(sid) if sid is not None else None
    except (TypeError, ValueError):
        sid_int = None
    if sid_int is None:
        return None
    return (row.get("user_pseudo_id"), sid_int)


def build_keep_predicate(
    *,
    excl_cities: Optional[set] = None,
    excl_countries: Optional[set] = None,
    hide_unknown_cities: bool = False,
    owner_ids: Optional[set] = None,
    keep_devices: Optional[set] = None,
    keep_landed: Optional[set] = None,
    require_videos: bool = False,
    require_extra_lang: bool = False,
    require_chat: bool = False,
    chat_count_map: Optional[dict] = None,
    user_pseudo_id_filter: Optional[str] = None,
) -> Callable[[dict], bool]:
    """Build a `_keep(row) -> bool` predicate from the dashboard filter knobs.

    Pass empty / None for any knob to disable that branch — a caller whose
    SQL already filters cities can leave `excl_cities=None` and the city
    branch becomes a no-op.

    Parameters mirror the dashboard query string + the precomputed sets
    callers already build (`csv_param(...)` → `set(...)`).
    """
    excl_cities = excl_cities or set()
    excl_countries = excl_countries or set()
    owner_ids = owner_ids or set()
    keep_devices = keep_devices or set()
    keep_landed = keep_landed or set()
    chat_count_map = chat_count_map or {}

    def _keep(r: dict) -> bool:
        if user_pseudo_id_filter and r.get("user_pseudo_id") != user_pseudo_id_filter:
            return False
        city = r.get("city")
        if hide_unknown_cities and (not city or city == "(not set)"):
            return False
        if city in excl_cities:
            return False
        if r.get("country") in excl_countries:
            return False
        if r.get("user_pseudo_id") in owner_ids:
            return False
        if keep_devices:
            dev = (r.get("device") or "").strip().lower()
            # Treat anything outside the known list as "other" — matches the
            # dropdown options so the filter and the chip stay in sync.
            bucket = dev if dev in DEVICE_OPTIONS else ("other" if dev else "")
            if bucket not in keep_devices:
                return False
        if keep_landed:
            lv = resolve_landed_via(r) or ""
            if lv not in keep_landed:
                return False
        if require_videos and not (r.get("video_ids") or []):
            return False
        if require_extra_lang:
            # "Extra" = at least one language in languages_used that isn't
            # the video's own language. Mirrors the card-side rule.
            vlang = (r.get("video_lang") or "").strip()
            extras = [l for l in (r.get("languages_used") or []) if l and l != vlang]
            if not extras:
                return False
        if require_chat:
            key = _row_session_key(r)
            if not (key and chat_count_map.get(key, 0) > 0):
                return False
        return True

    return _keep
