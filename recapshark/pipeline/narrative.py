"""
Session narrative generator (Phase 5a — template-only, no LLM).

`build(session_row)` walks the precomputed BQ aggregate (the same shape that
`etl_sessions._row_to_payload` produces) and returns a 1-3 sentence prose
summary suitable for display on a session card.

Design rules:
  * Templates only — no LLM, no PII, no cost, no latency.
  * Inputs are enums + counts + timestamps, never free-form text. Chat text and
    video titles arrive in later sub-phases (5d, 5b) via separate joins, not by
    reading anything raw out of GA4.
  * Falls back gracefully — any missing field is skipped, never `None` in prose.
  * Pure function so it can be unit-tested without DB or network.

Example output:
    "Arrived 5:44pm from Milan, Italy on desktop / Windows. Pasted video qADTr7d6gMU.
     Spent 2m on Summary, then 45s on Subtitles. Asked 2 chat questions. Translated
     to es. Left after 4m 13s."
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional

# ── enum prettifiers ────────────────────────────────────────────────────────
# Tab IDs in analytics.js are lowercase; we want title-case in prose.
_TAB_LABELS = {
    "summary":    "Summary",
    "subtitles":  "Subtitles",
    "transcript": "Transcript",
    "chat":       "Chat",
}


# ── tiny formatters ─────────────────────────────────────────────────────────
def _fmt_duration(sec: float) -> str:
    """Compact human duration. Mirrors the dashboard's fmtDuration() in JS so
    the prose reads consistently with the badges next to it."""
    sec = int(sec or 0)
    if sec < 1:
        return "<1s"
    if sec < 60:
        return f"{sec}s"
    m, s = divmod(sec, 60)
    if m < 60:
        return f"{m}m {s}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m}m" if m else f"{h}h"


def _fmt_clock(iso_ts: Optional[str]) -> Optional[str]:
    """ISO timestamp → '5:44pm' (UTC, no timezone tag — we don't know visitor's TZ).
    Returns None if the timestamp is missing or unparseable so callers can skip the line."""
    if not iso_ts:
        return None
    try:
        # Python's fromisoformat tolerates trailing Z only on 3.11+; normalize first.
        s = iso_ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        h12 = dt.hour % 12 or 12
        ampm = "am" if dt.hour < 12 else "pm"
        return f"{h12}:{dt.minute:02d}{ampm}"
    except (ValueError, TypeError):
        return None


def _parse_ts(iso_ts: Optional[str]) -> Optional[datetime]:
    if not iso_ts:
        return None
    try:
        s = iso_ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


# ── visit-context (Phase 5e) ────────────────────────────────────────────────
def _fmt_relative_when(days_ago: int, hours_ago: int) -> str:
    """Compact human relative time for the "first was X ago" clause.
    Tiers chosen so the prose stays readable at any age:
      <1d  -> "earlier today" / "Nh ago"
      1-7d -> "yesterday" / "N days ago"
      7-29 -> "N weeks ago"
      30+  -> "N months ago"
      365+ -> "N years ago"
    """
    if days_ago <= 0:
        if hours_ago <= 1:
            return "earlier today"
        return f"{hours_ago}h ago"
    if days_ago == 1:
        return "yesterday"
    if days_ago < 7:
        return f"{days_ago} days ago"
    if days_ago < 30:
        weeks = days_ago // 7
        return f"{weeks} week{'s' if weeks != 1 else ''} ago"
    if days_ago < 365:
        months = days_ago // 30
        return f"{months} month{'s' if months != 1 else ''} ago"
    years = days_ago // 365
    return f"{years} year{'s' if years != 1 else ''} ago"


def _fmt_visit_prefix(visit_context: Optional[dict]) -> Optional[str]:
    """Prepend a visit-history headline. Examples:
      - 'First visit.'
      - 'Visit #2 (first was 3h ago).'
      - 'Visit #5 (first was 2 weeks ago).'
    Returns None if no context was supplied (pre-5e callers / BQ fallback)."""
    if not visit_context:
        return None
    if visit_context.get("is_first"):
        return "First visit."
    n = int(visit_context.get("visit_number") or 0)
    if n <= 1:
        return None   # context says not-first but the number disagrees; skip rather than lie
    days = int(visit_context.get("days_since_first") or 0)
    hours = int(visit_context.get("hours_since_first") or 0)
    return f"Visit #{n} (first was {_fmt_relative_when(days, hours)})."


def _join_geo(city: Optional[str], region: Optional[str], country: Optional[str]) -> Optional[str]:
    """'Milan, Italy' / 'Forest City, Florida, United States' / None.
    Drops GA4's '(not set)' sentinel so we don't render it verbatim."""
    parts = [p for p in (city, region, country) if p and p != "(not set)"]
    if not parts:
        return None
    # Skip region if it equals city (common for big cities).
    if len(parts) >= 2 and parts[0] == parts[1]:
        parts = [parts[0]] + parts[2:]
    return ", ".join(parts)


def _join_device(device: Optional[str], os: Optional[str]) -> Optional[str]:
    """'desktop / Windows' / None. Browser is omitted for brevity in the narrative —
    it's still shown in the device chip on the card."""
    parts = [p for p in (device, os) if p and p != "(not set)"]
    return " / ".join(parts) if parts else None


# ── tab-dwell calculation ───────────────────────────────────────────────────
# Walks tab_switched events and the session boundaries to compute time spent on
# each tab. We assume the visitor lands on Summary (RecapShark's default tab) until
# the first tab_switched event tells us otherwise — matches actual app behavior.
def _compute_tab_dwells(
    raw_events: list[dict],
    session_start: Optional[datetime],
    session_end: Optional[datetime],
) -> list[tuple[str, int]]:
    """Returns ordered [(tab_label, seconds), ...] in the order the user visited them.
    Empty list if no tab_switched events and no session boundaries."""
    if not raw_events or not session_start or not session_end:
        return []

    # Build the visit timeline: (start_ts, tab) tuples in chronological order.
    visits: list[tuple[datetime, str]] = []

    # Default landing tab is Summary — RecapShark opens there. If the first
    # tab_switched event happens at t > session_start, the gap was time on Summary.
    visits.append((session_start, "summary"))

    for e in raw_events:
        if e.get("event_name") != "tab_switched":
            continue
        tab = e.get("tab")
        if not tab:
            continue
        ts = _parse_ts(e.get("ts"))
        if ts is None:
            continue
        visits.append((ts, tab))

    # Compute durations: each visit ends when the next one starts (or at session_end
    # for the final visit). Then merge consecutive visits to the same tab — this
    # collapses spurious double-fires of tab_switched without losing the time.
    durations: dict[str, int] = {}
    order: list[str] = []
    for i, (ts, tab) in enumerate(visits):
        end_ts = visits[i + 1][0] if i + 1 < len(visits) else session_end
        secs = max(0, int((end_ts - ts).total_seconds()))
        if secs == 0 and tab in durations:
            continue
        if tab not in durations:
            order.append(tab)
        durations[tab] = durations.get(tab, 0) + secs

    # Drop zero-second tabs (caused by very rapid switching) — they read like noise.
    return [(_TAB_LABELS.get(t, t), durations[t]) for t in order if durations[t] >= 2]


def _fmt_tab_sequence(dwells: list[tuple[str, int]]) -> Optional[str]:
    """[('Summary', 120), ('Subtitles', 45)] → 'Spent 2m on Summary, then 45s on Subtitles.'
    Returns None for empty input. Caps at 4 tabs to keep prose tight."""
    if not dwells:
        return None
    dwells = dwells[:4]
    if len(dwells) == 1:
        tab, secs = dwells[0]
        return f"Spent {_fmt_duration(secs)} on {tab}."
    parts = [f"{_fmt_duration(secs)} on {tab}" for tab, secs in dwells]
    if len(parts) == 2:
        return f"Spent {parts[0]}, then {parts[1]}."
    return "Spent " + ", ".join(parts[:-1]) + f", then {parts[-1]}."


# ── side-fact extraction ────────────────────────────────────────────────────
def _count_events(raw_events: list[dict], name: str) -> int:
    return sum(1 for e in raw_events if e.get("event_name") == name)


def _distinct_values(raw_events: list[dict], event_name: str, field: str) -> list:
    """Distinct, non-null `field` values from events of `event_name`, in first-seen order."""
    seen, out = set(), []
    for e in raw_events:
        if e.get("event_name") != event_name:
            continue
        v = e.get(field)
        if v is None or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def _fmt_videos(video_ids: Iterable[str], titles: Optional[dict] = None) -> Optional[str]:
    """Render the "pasted videos" sentence.

    Kept deliberately title-less: the dashboard renders the actual video links
    + titles as colored chips on the bottom row of each session card, so
    repeating the title in the prose was just noise. The `titles` argument is
    accepted (and ignored) for backward compatibility with callers that still
    pass it through.

    Output:
        - 'Pasted a video.'
        - 'Pasted 3 videos.'
    """
    vids = [v for v in (video_ids or []) if v]
    if not vids:
        return None
    if len(vids) == 1:
        return "Pasted a video."
    return f"Pasted {len(vids)} videos."


def _fmt_chat(chat_count: int, messages: Optional[list[str]] = None) -> Optional[str]:
    """Phase 5d: if `messages` is supplied, inline the actual question text in
    smart-quotes. Falls back to a count-only sentence (Phase 5a behavior) when
    we don't have the text — that's the case for the BQ-fallback path or when
    chat logging wasn't wired up yet for that visit.

    Truncates per-message at 160 chars and the visible list at 3 to keep the
    narrative readable. Trailing "and N more" makes the truncation explicit."""
    if chat_count <= 0 and not messages:
        return None
    msgs = [m.strip() for m in (messages or []) if m and m.strip()]
    n = max(chat_count, len(msgs))

    if not msgs:
        return "Asked 1 chat question." if n == 1 else f"Asked {n} chat questions."

    def _q(s: str) -> str:
        s = s.replace("\n", " ").replace("\r", " ").strip()
        if len(s) > 160:
            s = s[:157].rstrip() + "\u2026"
        return f"\u201c{s}\u201d"

    if n == 1 and len(msgs) >= 1:
        return f"Asked: {_q(msgs[0])}."
    visible = msgs[:3]
    quoted = ", ".join(_q(m) for m in visible[:-1]) + (" and " if len(visible) > 1 else "") + _q(visible[-1])
    extra = n - len(visible)
    suffix = f" (and {extra} more)" if extra > 0 else ""
    return f"Asked {n} chat question{'s' if n != 1 else ''}: {quoted}{suffix}."


def _fmt_languages(langs: Iterable[str]) -> Optional[str]:
    langs = [l for l in (langs or []) if l]
    if not langs:
        return None
    if len(langs) == 1:
        return f"Translated to {langs[0]}."
    return "Translated to " + ", ".join(langs[:-1]) + f" and {langs[-1]}."


def _fmt_extras(raw_events: list[dict]) -> Optional[str]:
    """Compact roll-up of secondary actions (themes, chapters, searches, exports).
    Only emitted if at least one count is non-zero, joined into one sentence to
    avoid a wall of single-clause sentences."""
    bits = []
    chapters = _count_events(raw_events, "chapter_clicked")
    searches = _count_events(raw_events, "transcript_search")
    themes   = _count_events(raw_events, "theme_changed")
    exports  = _count_events(raw_events, "export_confirmed")
    if chapters:
        bits.append(f"clicked {chapters} chapter{'s' if chapters != 1 else ''}")
    if searches:
        bits.append(f"ran {searches} transcript search{'es' if searches != 1 else ''}")
    if themes:
        bits.append(f"changed theme {themes}x")
    if exports:
        bits.append(f"exported {exports} time{'s' if exports != 1 else ''}")
    if not bits:
        return None
    if len(bits) == 1:
        return "Also " + bits[0] + "."
    return "Also " + ", ".join(bits[:-1]) + f" and {bits[-1]}."


# ── public entry point ──────────────────────────────────────────────────────
def build(
    session_row: dict,
    video_titles: Optional[dict] = None,
    chat_messages: Optional[list[str]] = None,
    visit_context: Optional[dict] = None,
) -> str:
    """Produce a narrative paragraph for a single Supabase rs_sessions row (or
    the equivalent dict shape produced by etl_sessions._row_to_payload).

    Optional enrichments:
      * `video_titles={video_id: {"title","channel"}}` — Phase 5b real titles.
      * `chat_messages=["why did he do that?", ...]` — Phase 5d full chat text
        from rs_chat_messages, inlined into the prose. Without this we fall
        back to the count-only "Asked 2 chat questions." line.
      * `visit_context={"is_first":bool, "visit_number":int,
            "days_since_first":int, "hours_since_first":int}` — Phase 5e cross-
        session context. Renders as a leading "First visit." / "Visit #N (first
        was X ago)." sentence so the reader knows immediately whether this is
        a new face or a repeat visitor.

    Empty string is never returned — the worst case is a one-liner with just the
    duration, since `started_at`/`ended_at` are always present when ETL ran.
    """
    raw = session_row.get("raw_events") or []
    started_at = _parse_ts(session_row.get("started_at"))
    ended_at   = _parse_ts(session_row.get("ended_at"))
    duration   = session_row.get("duration_sec") or 0

    sentences: list[str] = []

    # 0. Visit-history headline (5e). Goes first so the reader's first signal
    # is "is this someone new?" before any of the per-visit detail.
    visit_prefix = _fmt_visit_prefix(visit_context)
    if visit_prefix:
        sentences.append(visit_prefix)

    # 1. Arrival sentence: time + place + device.
    arrival_bits = []
    clock = _fmt_clock(session_row.get("started_at"))
    if clock:
        arrival_bits.append(f"Arrived {clock}")
    geo = _join_geo(session_row.get("city"), session_row.get("region"), session_row.get("country"))
    if geo:
        arrival_bits.append(f"from {geo}")
    dev = _join_device(session_row.get("device"), session_row.get("os"))
    if dev:
        arrival_bits.append(f"on {dev}")
    if arrival_bits:
        sentences.append(" ".join(arrival_bits) + ".")

    # 2. Pasted videos — title-enriched in 5b when a titles map is supplied.
    vids_sentence = _fmt_videos(session_row.get("video_ids"), video_titles)
    if vids_sentence:
        sentences.append(vids_sentence)

    # 3. Tab dwells — the meatiest signal of how the user actually used the app.
    tab_sentence = _fmt_tab_sequence(_compute_tab_dwells(raw, started_at, ended_at))
    if tab_sentence:
        sentences.append(tab_sentence)

    # 4. Chat — text-enriched in 5d when chat_messages is supplied.
    chat_sentence = _fmt_chat(_count_events(raw, "chat_sent"), chat_messages)
    if chat_sentence:
        sentences.append(chat_sentence)

    # 5. Translation. Prefer the precomputed languages_used array when present
    # (ETL already deduped it), fall back to walking events for edge cases.
    langs = session_row.get("languages_used") or _distinct_values(raw, "language_changed", "lang")
    lang_sentence = _fmt_languages(langs)
    if lang_sentence:
        sentences.append(lang_sentence)

    # 6. Extras (themes, chapters, searches, exports) in a single roll-up sentence.
    extras_sentence = _fmt_extras(raw)
    if extras_sentence:
        sentences.append(extras_sentence)

    # 7. Departure — always emitted as the closer if we have any duration at all.
    if duration > 0:
        sentences.append(f"Left after {_fmt_duration(duration)}.")

    return " ".join(sentences) if sentences else "No activity recorded."
