"""
Pagination metadata wrapper + BQ row → wire-format event converter.

Owns: paginate() helper used by every list endpoint, row_to_event() that
flattens the single-pass event_params struct into the JSON shape the
dashboard JS expects.

Imports allowed: stdlib only. Pure functions, no internal-package imports.
"""


def paginate(rows: list, limit: int, offset: int) -> dict:
    """Wrap list rows with pagination metadata. Caller MUST have fetched limit+1 rows
    so we can detect has_more without a second COUNT(*) query (which would double the
    BigQuery cost on every page load).
    """
    has_more = len(rows) > limit
    visible = rows[:limit]
    return {
        "rows": visible,
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
        "next_offset": (offset + limit) if has_more else None,
        "count": len(visible),
    }


def row_to_event(r):
    """Flatten a BQ Row whose `p` field is the single-pass event_params struct (3.5.1)
    into the wire format the dashboard expects. Top-level fields (geo, device) stay
    on `r` directly; everything from event_params lives under `r.p`.
    """
    p = r.p
    return {
        "ts": r.ts.isoformat() if r.ts else None,
        "event_name": r.event_name,
        "user_pseudo_id": getattr(r, "user_pseudo_id", None),
        "device": getattr(r, "device", None),
        "city": getattr(r, "city", None),
        "region": getattr(r, "region", None),
        "country": getattr(r, "country", None),
        "session_id": p["session_id"],
        "page": p["page"],
        "tab": p["tab"],
        "video_id": p["video_id"],
        "lang": p["lang"],
        "theme": p["theme"],
        "mode": p["mode"],
        "chapter_index": p["chapter_index"],
        "chapter_title_length": p["chapter_title_length"],
        "query_length": p["query_length"],
        "word_count": p["word_count"],
        "has_question_mark": p["has_question_mark"],
        "message_length": p["message_length"],
        "format": p["format"],
        "enabled": p["enabled"],
    }
