"""
RecapShark Pipeline Worker
GPT helper functions for short summary + chapters generation.
"""

import json
import logging

from langs import lang_code_to_name as _lang_name
from constants import SAMPLED_TEXT_MAX_CHARS, SHORT_VIDEO_THRESHOLD_SEC
from prompts import (  # noqa: F401  (re-exported for backwards compat)
    _CASUAL_CHAPTER_VOICE,
    _CASUAL_FAST_CHAPTERS_PROMPT,
    _CASUAL_CHAPTERS_V2_PROMPT,
    _CASUAL_REDUCE_PROMPT,
    _FAST_SUMMARY_PROMPT,
    _FAST_CHAPTERS_PROMPT,
    _CHAPTERS_V2_PROMPT,
    _MAP_PROMPT,
    _REDUCE_PROMPT,
    _CHAT_PROMPT,
    _CASUAL_CHAT_OVERLAY,
    _TITLE_COLORS_PROMPT,
    _FORMAL_SUMMARY_PROMPT,
    _FORMAL_CHAPTERS_PROMPT,
)


logger = logging.getLogger(__name__)


def _build_sampled_text(snippets, full_text, video_duration):
    """Build strategically sampled text for GPT: full for short videos, 3 slices for long."""
    SLICE_SECONDS = 300

    if video_duration <= SHORT_VIDEO_THRESHOLD_SEC:
        return full_text[:SAMPLED_TEXT_MAX_CHARS]

    slices_def = [(0.00, 0.03), (0.45, 0.48), (0.85, 0.88)]
    budget = SAMPLED_TEXT_MAX_CHARS // len(slices_def)
    parts = []

    for start_pct, end_pct in slices_def:
        t_start = video_duration * start_pct
        t_end = max(video_duration * end_pct, t_start + SLICE_SECONDS)
        t_end = min(t_end, video_duration)
        segs = [s for s in snippets if t_start <= s["start"] < t_end]

        slice_text = ""
        for s in segs:
            candidate = (slice_text + " " + s["text"]).strip() if slice_text else s["text"]
            if len(candidate) > budget:
                break
            slice_text = candidate

        if slice_text:
            header = f"[{int(t_start / 60)}:{int(t_start % 60):02d} - {int(t_end / 60)}:{int(t_end % 60):02d}]"
            parts.append(f"{header}\n{slice_text}")

    return "\n\n".join(parts)


def _fast_call_summary(client, sampled_text, lang, video_duration):
    """GPT call for short preview summary (plain text)."""
    lang_note = f"\n\nThe transcript is in {_lang_name(lang)}. Respond in the SAME language." if lang else "\n\nRespond in the SAME language as the transcript below."
    preamble = ""
    if video_duration > 900:
        preamble = f"This is a {int(video_duration / 60)}-minute video. Below are sampled slices from start, middle, and end.\n\n"

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": _FAST_SUMMARY_PROMPT + lang_note},
            {"role": "user", "content": preamble + sampled_text},
        ],
        temperature=0.3,
        max_tokens=150,
    )
    raw = response.choices[0].message.content.strip()
    return [p.strip() for p in raw.split("\n\n") if p.strip()]


def _call_chapters_v2(client, timestamped_text, lang, video_duration, casual=True):
    """GPT call for chapters using full transcript (no sampling)."""
    lang_note = f"\n\nThe transcript is in {_lang_name(lang)}. Respond in the SAME language." if lang else "\n\nRespond in the SAME language as the transcript below."
    preamble = f"This video is {_fmt_hms(video_duration)} long ({int(video_duration)} seconds total).\n\n"
    max_tok = 800 if video_duration > 3600 else 500
    prompt = _CASUAL_CHAPTERS_V2_PROMPT if casual else _CHAPTERS_V2_PROMPT

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": prompt + lang_note},
            {"role": "user", "content": preamble + timestamped_text},
        ],
        temperature=0.45 if casual else 0.3,
        max_tokens=max_tok,
        response_format={"type": "json_object"},
    )
    raw = response.choices[0].message.content.strip()
    data = json.loads(raw)
    return data.get("chapters", [])


def _fmt_hms(seconds):
    """Format seconds as H:MM:SS."""
    t = int(seconds)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


def _build_even_sampled_text(snippets, video_duration):
    """Take every Nth segment so the LLM sees the full timeline, capped to ~12k chars."""
    if not snippets:
        return ""
    n = max(1, len(snippets) // 150)
    sampled = snippets[::n]
    lines = []
    total = 0
    for s in sampled:
        line = f"[{_fmt_hms(s['start'])}] {s['text']}"
        total += len(line) + 1
        if total > SAMPLED_TEXT_MAX_CHARS:
            break
        lines.append(line)
    return "\n".join(lines)


def _map_reduce_chapters(client, snippets, lang, video_duration, casual=True):
    """Two-pass chapter generation: map (parallel per-window) then reduce."""
    import concurrent.futures

    MIN_WINDOWS = 4
    MAX_WINDOWS = 15
    TARGET_WINDOW_SEC = 900
    num_windows = max(MIN_WINDOWS, min(MAX_WINDOWS, round(video_duration / TARGET_WINDOW_SEC)))
    window_sec = video_duration / num_windows

    windows = []
    for i in range(num_windows):
        t_start = i * window_sec
        t_end = (i + 1) * window_sec
        segs = [s for s in snippets if t_start <= s["start"] < t_end]
        if not segs and i > 0:
            continue
        text_lines = [f"[{int(s['start'])}s] {s['text']}" for s in segs]
        joined = "\n".join(text_lines)[:10000]
        windows.append({
            "index": i,
            "t_start": int(t_start),
            "t_end": int(t_end),
            "text": joined,
        })

    lang_note = f"\n\nThe transcript is in {_lang_name(lang)}. Respond in the SAME language for topic titles." if lang else ""

    def map_call(w):
        preamble = (
            f"Section {w['index'] + 1}/{num_windows}: "
            f"{int(w['t_start'])}s to {int(w['t_end'])}s "
            f"of a {int(video_duration)}s video.\n\n"
        )
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _MAP_PROMPT + lang_note},
                {"role": "user", "content": preamble + w["text"]},
            ],
            temperature=0,
            max_tokens=300,
            response_format={"type": "json_object"},
        )
        data = json.loads(resp.choices[0].message.content.strip())
        shifts = data.get("shifts", [])
        for s in shifts:
            s["start_time"] = int(s.get("start_time", w["t_start"]))
            s["score"] = int(s.get("score", 5))
        return shifts

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(10, len(windows))) as pool:
        results = list(pool.map(map_call, windows))

    anchors = []
    for shifts in results:
        anchors.extend(shifts)
    anchors.sort(key=lambda a: a["start_time"])

    last_chapter_min = int(video_duration * 0.85)
    total_seconds = int(video_duration)

    reduce_prompt = _REDUCE_PROMPT.format(
        last_chapter_min=last_chapter_min,
        total_seconds=total_seconds,
    )

    anchor_lines = "\n".join(
        f"- {a['start_time']}s [score:{a['score']}] {a['topic']}"
        for a in anchors
    )

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": (_CASUAL_REDUCE_PROMPT if casual else _REDUCE_PROMPT).format(last_chapter_min=last_chapter_min, total_seconds=total_seconds) + lang_note},
            {"role": "user", "content": anchor_lines},
        ],
        temperature=0.3 if casual else 0,
        max_tokens=800,
        response_format={"type": "json_object"},
    )
    data = json.loads(resp.choices[0].message.content.strip())
    chapters = data.get("chapters", [])
    for ch in chapters:
        ch["start_time"] = int(ch.get("start_time", 0))
    return chapters


# Per-turn highlighting reminder — appended to the user message AFTER the
# conversation history. Critical because past assistant turns may not contain
# highlighting markers (e.g. responses from before the highlighting prompt
# was added); without this the model imitates the unmarked style of its own
# history and ignores the system prompt's rules.
_CHAT_HIGHLIGHT_REMINDER = (
    "Wrap PEOPLE in [[double brackets]] (use TWO brackets each side, never one), "
    "PLACES — including common country names like ((United States)), ((China)) — "
    "in ((double parens)), KEY TERMS in **double asterisks**. "
    "Do NOT mark dates/numbers."
)


def _build_chat_messages(transcript_text, question, history, lang, video_lang,
                         video_duration, video_title, video_channel, casual):
    """Pure: build the messages list sent to OpenAI for a chat turn.

    Order is: system prompt + lang note → user transcript+meta → conversation
    history (alternating user/assistant) → optional casual overlay → user
    question + per-turn reminder.
    """
    transcript_lang = _lang_name(video_lang) if video_lang else None
    response_lang = _lang_name(lang) if lang else None

    lang_note = ""
    if response_lang:
        lang_note = (
            f"\n\nThe transcript is in {transcript_lang or 'the video language'}."
            f" You MUST respond in {response_lang}."
        )

    meta = ""
    if video_title:
        meta += f"Video title: {video_title}\n"
    if video_channel:
        meta += f"Channel: {video_channel}\n"

    messages = [
        {"role": "system", "content": _CHAT_PROMPT + lang_note},
        {"role": "user", "content": f"{meta}Here is the full transcript of a {int(video_duration)}s video:\n\n{transcript_text}"},
    ]

    for turn in history:
        messages.append({"role": "user", "content": turn["question"]})
        messages.append({"role": "assistant", "content": turn["answer"]})

    if casual:
        messages.append({"role": "system", "content": _CASUAL_CHAT_OVERLAY})

    if response_lang:
        reminder = (
            f"\n\n[Respond in {response_lang}. Include at least one [MM:SS] timestamp. "
            f"{_CHAT_HIGHLIGHT_REMINDER} "
            f"Return valid JSON with \"answer\" and \"context\".]"
        )
    else:
        reminder = (
            "\n\n[Respond with valid JSON containing \"answer\" and \"context\". "
            f"Include at least one [MM:SS] timestamp. {_CHAT_HIGHLIGHT_REMINDER}]"
        )

    messages.append({"role": "user", "content": question + reminder})
    return messages


def _call_openai_chat(client, messages, casual):
    """HTTP: send the assembled messages to OpenAI and return the raw
    `.message.content.strip()` string. Temperature lifts slightly in casual
    mode for a looser tone."""
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        temperature=0.45 if casual else 0.3,
        max_tokens=1000,
        response_format={"type": "json_object"},
    )
    return response.choices[0].message.content.strip()


def _parse_chat_response(raw):
    """Parse the JSON-shaped chat response. Falls back to the raw string
    when the content isn't valid JSON (the model occasionally drops braces
    on long responses); answer/context concat when both are present."""
    import json as _json
    try:
        data = _json.loads(raw)
        answer = data.get("answer", "")
        context = data.get("context", "")
        if answer and context:
            return f"{answer}\n\n{context}"
        return answer or context or raw
    except (_json.JSONDecodeError, AttributeError):
        return raw


def _call_chat(client, transcript_text, question, history, lang, video_lang="",
               video_duration=0, video_title="", video_channel="", summary="",
               casual=False):
    """GPT call for chat: answer a question about the video."""
    messages = _build_chat_messages(
        transcript_text, question, history, lang, video_lang,
        video_duration, video_title, video_channel, casual,
    )
    raw = _call_openai_chat(client, messages, casual)
    # Diagnostic: log whether the LLM actually emitted highlighting markers.
    # If counts are 0 the prompt is being ignored — stop blaming the frontend
    # and tighten the prompt instead.
    logger.info(
        "[CHAT] highlighting markers in LLM raw response: "
        "people=[[]]×%d, places=(())×%d, terms=**×%d",
        raw.count("[["), raw.count("(("), raw.count("**") // 2,
    )
    return _parse_chat_response(raw)


def _fast_call_chapters(client, sampled_text, lang, video_duration, casual=True):
    """GPT call for chapters (JSON)."""
    lang_note = f"\n\nThe transcript is in {_lang_name(lang)}. Respond in the SAME language." if lang else "\n\nRespond in the SAME language as the transcript below."
    preamble = ""
    if video_duration > 900:
        preamble = (
            f"This is a {int(video_duration / 60)}-minute video. "
            "Below are sampled slices from start, middle, and end. "
            "Generate chapters that cover the ENTIRE video timeline, not just the sampled parts.\n\n"
        )
    prompt = _CASUAL_FAST_CHAPTERS_PROMPT if casual else _FAST_CHAPTERS_PROMPT

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": prompt + lang_note},
            {"role": "user", "content": preamble + sampled_text},
        ],
        temperature=0.45 if casual else 0.3,
        max_tokens=300,
        response_format={"type": "json_object"},
    )
    raw = response.choices[0].message.content.strip()
    data = json.loads(raw)
    return data.get("chapters", [])


def _call_title_colors(client, title, prompt_override=None):
    """Split a video title into colored segments. Retries up to 3 times with gpt-4o if validation fails."""
    prompt = prompt_override or _TITLE_COLORS_PROMPT
    models = ["gpt-4o-mini", "gpt-4o", "gpt-4o", "gpt-4o"]

    for attempt, model in enumerate(models):
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": title},
            ],
            temperature=0.1,
            max_tokens=400,
            response_format={"type": "json_object"},
        )
        raw = response.choices[0].message.content.strip()
        data = json.loads(raw)
        segments = data.get("segments", [])
        segments = _validate_title_color_segments(segments)

        if _segments_valid(segments):
            return {"segments": segments}

    return {"segments": segments}


def _segments_valid(segments):
    """Check that segments have exactly 1 red and 1 yellow, both 3+ visible chars."""
    red = [s for s in segments if s.get("color") == "red"]
    yellow = [s for s in segments if s.get("color") == "yellow"]
    if len(red) != 1 or len(yellow) != 1:
        return False
    if len(red[0].get("text", "").replace(" ", "")) < 3:
        return False
    if len(yellow[0].get("text", "").replace(" ", "")) < 3:
        return False
    return True


def _validate_title_color_segments(segments):
    """Demote red/yellow segments shorter than 3 visible non-space chars to black, then merge adjacent blacks."""
    for seg in segments:
        if seg.get("color") in ("red", "yellow"):
            visible = seg.get("text", "").replace(" ", "")
            if len(visible) < 3:
                seg["color"] = "black"

    merged = []
    for seg in segments:
        if merged and merged[-1]["color"] == "black" and seg["color"] == "black":
            merged[-1]["text"] += seg["text"]
        else:
            merged.append(seg)
    return merged


def _call_formal_summary(client, summary_text, lang="", custom_prompt="", model_override=""):
    """Rewrite summary in formal/professional tone."""
    lang_note = (
        f"\n\nThe text is in {_lang_name(lang)}. Respond in {_lang_name(lang)}. "
        f"Do not translate to another language. Do not shorten, summarize, expand, or condense. "
        f"Rewrite every paragraph with the same detail, structure, and formatting. "
        f"Professional tone should feel native to {_lang_name(lang)}."
    ) if lang else ""

    prompt = custom_prompt if custom_prompt else _FORMAL_SUMMARY_PROMPT
    model = model_override if model_override else "gpt-4o-mini"

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": prompt + lang_note},
            {"role": "user", "content": summary_text},
        ],
        temperature=0.3,
        max_tokens=4000,
        frequency_penalty=0.3,
    )
    return response.choices[0].message.content.strip()


def _call_formal_chapters(client, chapters, lang=""):
    """Rewrite chapter titles in formal/professional tone."""
    import json as _json
    lang_note = (
        f"\n\nThe text is in {_lang_name(lang)}. Respond in {_lang_name(lang)}."
    ) if lang else ""

    chapters_text = _json.dumps({"chapters": chapters})

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": _FORMAL_CHAPTERS_PROMPT + lang_note},
            {"role": "user", "content": chapters_text},
        ],
        temperature=0.3,
        max_tokens=800,
        frequency_penalty=0.3,
        response_format={"type": "json_object"},
    )
    raw = response.choices[0].message.content.strip()
    try:
        data = _json.loads(raw)
        return data.get("chapters", [])
    except (_json.JSONDecodeError, AttributeError):
        return []
