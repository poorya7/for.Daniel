"""
YouTube video-title cache.

Resolves YouTube `video_id` -> {title, channel} via the public oEmbed endpoint
and caches results forever in Supabase `rs_video_titles`.

Why oEmbed and not the Data API:
  * No API key needed, no quota, no billing setup.
  * Returns title + channel name, which is everything the narrative needs.
  * Public/unlisted videos resolve; private/deleted return 401/404 — we cache
    those as `status='not_found'` so we never retry them.

Why a separate Supabase table:
  * Titles are immutable (YouTube videos can be renamed but rarely are, and a
    stale title is fine for an analytics narrative).
  * One bulk fetch per ETL batch -> at most one oEmbed call per *new* video_id
    we've ever seen, total. After backfill is warm, ETL hits Supabase only.

Public API:
  * `resolve_many(video_ids: list[str]) -> dict[str, dict | None]`
        Returns {video_id: {title, channel}} for known/resolvable IDs;
        value is None for IDs that resolved as 'not_found'/'error'.
        Hits oEmbed only for IDs not already cached.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Iterable, Optional

import httpx

import supabase_owner_store as _owner


_OEMBED_URL = "https://www.youtube.com/oembed"
_HTTP_TIMEOUT = 6.0          # per oEmbed call
_PER_LOOKUP_DELAY_SEC = 0.05 # tiny delay so we don't hammer YouTube during backfills


# ── Supabase reads ─────────────────────────────────────────────────────────
def _fetch_cached(video_ids: list[str]) -> dict[str, dict]:
    """Bulk lookup of already-cached titles. Returns {video_id: row} for hits.
    Misses are simply absent from the dict — caller resolves them via oEmbed."""
    if not video_ids or not _owner.is_configured():
        return {}
    # PostgREST `in.(...)` filter expects comma-separated values without quotes
    # for plain text. video_id charset is alphanumeric + `_-`, so no escaping needed.
    ids_csv = ",".join(video_ids)
    url = (
        f"{_owner.supabase_url()}/rest/v1/rs_video_titles"
        f"?select=video_id,title,channel,status"
        f"&video_id=in.({ids_csv})"
    )
    try:
        with httpx.Client(timeout=10.0) as c:
            resp = c.get(url, headers=_owner.service_headers())
            if resp.status_code >= 400:
                return {}
            rows = resp.json() or []
    except httpx.HTTPError:
        return {}
    return {r["video_id"]: r for r in rows if r.get("video_id")}


def _upsert(rows: list[dict]) -> None:
    """Best-effort write-back of newly resolved titles. Failures are swallowed
    so a Supabase outage doesn't block ETL — we just lose the cache for this run."""
    if not rows or not _owner.is_configured():
        return
    url = f"{_owner.supabase_url()}/rest/v1/rs_video_titles?on_conflict=video_id"
    headers = {
        **_owner.service_headers(),
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    try:
        with httpx.Client(timeout=15.0) as c:
            c.post(url, headers=headers, json=rows)
    except httpx.HTTPError:
        pass


# ── oEmbed fetch ───────────────────────────────────────────────────────────
def _oembed(video_id: str) -> dict:
    """Returns a row ready for upsert. Status is 'ok' / 'not_found' / 'error'."""
    now_iso = datetime.now(timezone.utc).isoformat()
    base = {
        "video_id":   video_id,
        "title":      None,
        "channel":    None,
        "status":     "error",
        "fetched_at": now_iso,
    }
    # oEmbed accepts both watch URLs and youtu.be short links; watch URL is more
    # universally supported by YouTube's redirect logic.
    params = {"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"}
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT, follow_redirects=True) as c:
            resp = c.get(_OEMBED_URL, params=params)
        # 401/404 = video is private, deleted, or never existed. Cache as
        # 'not_found' so we never retry — a future un-deletion is rare and
        # an operator can DELETE the cache row to force a re-fetch.
        if resp.status_code in (401, 404):
            base["status"] = "not_found"
            return base
        if resp.status_code >= 400:
            return base   # transient error; will retry on next ETL run
        data = resp.json() or {}
        title = (data.get("title") or "").strip() or None
        channel = (data.get("author_name") or "").strip() or None
        if not title:
            base["status"] = "not_found"
            return base
        base["title"] = title
        base["channel"] = channel
        base["status"] = "ok"
        return base
    except (httpx.HTTPError, ValueError):
        return base


# ── public API ─────────────────────────────────────────────────────────────
def resolve_many(video_ids: Iterable[str]) -> dict[str, Optional[dict]]:
    """Return {video_id: {'title','channel'} | None} for every input.

    None means we know the video is unresolvable (cached 'not_found'/'error') or
    the lookup failed transiently. Callers should treat None the same way: fall
    back to the bare video_id in narratives.
    """
    ids = sorted({v for v in (video_ids or []) if v})
    if not ids:
        return {}

    cached = _fetch_cached(ids)
    out: dict[str, Optional[dict]] = {}
    to_fetch: list[str] = []

    for vid in ids:
        c = cached.get(vid)
        if not c:
            to_fetch.append(vid)
            continue
        if c.get("status") == "ok" and c.get("title"):
            out[vid] = {"title": c["title"], "channel": c.get("channel")}
        else:
            out[vid] = None   # known-bad; don't waste another oEmbed call

    if to_fetch:
        new_rows = []
        for vid in to_fetch:
            row = _oembed(vid)
            new_rows.append(row)
            if row["status"] == "ok" and row["title"]:
                out[vid] = {"title": row["title"], "channel": row.get("channel")}
            else:
                out[vid] = None
            time.sleep(_PER_LOOKUP_DELAY_SEC)
        _upsert(new_rows)

    return out
