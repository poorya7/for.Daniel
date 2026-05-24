"""
Summarize transcript text using OpenAI GPT.
Returns a list of paragraph strings.
"""

import logging
from datetime import date, datetime

from langs import lang_code_to_name as _lang_code_to_name, ADVANCED_MODEL_LANGS


logger = logging.getLogger(__name__)
from openai_client import get_client as _get_client
from constants import SAMPLED_TEXT_MAX_CHARS
from prompts import SYSTEM_PROMPT, CASUAL_SYSTEM_PROMPT, SUGGESTED_QUESTIONS_PROMPT  # noqa: F401


def _relative_date(date_str: str) -> str:
    """Convert 'YYYY-MM-DD' to a natural phrase like '4 days ago' or 'last month'."""
    try:
        published = datetime.strptime(date_str, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return date_str
    delta = date.today() - published
    days = delta.days
    if days < 0:
        days = 0
    if days == 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days} days ago"
    if days < 14:
        return "about a week ago"
    if days < 30:
        weeks = days // 7
        return f"about {weeks} weeks ago"
    if days < 60:
        return "about a month ago"
    if days < 365:
        months = days // 30
        return f"about {months} months ago"
    years = days // 365
    if years == 1:
        return "about a year ago"
    return f"about {years} years ago"


def summarize(transcript_text: str, is_partial: bool = False,
              video_meta: dict | None = None, lang: str = "en",
              casual: bool = True) -> list[str]:
    """Summarize transcript text into short paragraphs.
    is_partial=True tells GPT this is only part of the video.
    video_meta can include title, channel, upload_date, duration.
    lang: language code of the transcript; the summary is written in this same language.
    casual: when True, applies a sharp/blunt tone overlay to the summary.
    Returns a list of paragraph strings.
    """
    if not transcript_text or len(transcript_text.strip()) < 50:
        return []

    text = transcript_text[:SAMPLED_TEXT_MAX_CHARS]

    meta_lines = []
    if video_meta:
        if video_meta.get("title"):
            meta_lines.append(f"Title: {video_meta['title']}")
        if video_meta.get("channel"):
            meta_lines.append(f"Channel: {video_meta['channel']}")
        if video_meta.get("upload_date"):
            relative = _relative_date(video_meta["upload_date"])
            meta_lines.append(f"Published: {relative}")
        if video_meta.get("description"):
            meta_lines.append(f"Description: {video_meta['description']}")
    meta_block = "\n".join(meta_lines)

    preamble = "Below is the transcript of a YouTube video."
    if meta_block:
        preamble += f"\n\nVideo info:\n{meta_block}"
    if is_partial:
        preamble += "\n\n(Note: this is only the first few minutes of the video, not the full thing.)"
    lang_name = _lang_code_to_name(lang)
    lang_instruction = (f"\n\nThe transcript is in {lang_name}. Write the ENTIRE summary (all paragraphs, including Context) in {lang_name}."
                       if lang else "\n\nWrite the ENTIRE summary (all paragraphs, including Context) in the SAME language as the transcript.")

    try:
        client = _get_client()
        # Advanced / low-resource scripts: gpt-4o-mini reliably degenerates
        # into repetition loops when generating summaries directly in these
        # languages (see Amharic). `frequency_penalty=0.3` (further below)
        # is also key — even on gpt-4o, low-resource scripts can loop
        # without it.
        model = "gpt-4o" if lang in ADVANCED_MODEL_LANGS else "gpt-4o-mini"
        if model == "gpt-4o":
            logger.info("[SUMMARIZE] Using gpt-4o for lang=%s — tier upgrade", lang)
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": (CASUAL_SYSTEM_PROMPT if casual else SYSTEM_PROMPT) + lang_instruction},
                {"role": "user", "content": f"{preamble}\n\n{text}"},
            ],
            temperature=0.45 if casual else 0.3,
            max_tokens=1400,
            frequency_penalty=0.3,
        )

        raw = response.choices[0].message.content.strip()
        paragraphs = [p.strip() for p in raw.split("\n\n") if p.strip()]
        return paragraphs if paragraphs else [raw]

    except Exception as e:
        logger.warning("[SUMMARIZE] Summarization failed: %s", e)
        return ["Summary generation failed — will retry when complete."]


# ── Suggested chat questions (Phase 2) ──────────────────────────────────
# Generates 2 short, video-specific questions that surface as tappable
# chips in the chat UI alongside two fixed ones ("What's the video
# about?", "Summarize the video"). Runs in parallel with summarize() in
# routes.py so it adds no wallclock latency to the user.
# (`SUGGESTED_QUESTIONS_PROMPT` lives in `prompts.py` since Phase 4a A5.)


def suggest_questions(transcript_text: str, lang: str = "en",
                      video_meta: dict | None = None) -> list[str]:
    """Generate up to 10 video-specific suggested chat questions.
    First 2 are used as initial chips under the greeting; the remaining
    are rotated as follow-up chips after each AI answer in the chat.
    Returns [] on failure — callers should fall back to a default set
    rather than block the response.
    """
    if not transcript_text or len(transcript_text.strip()) < 50:
        return []

    text = transcript_text[:SAMPLED_TEXT_MAX_CHARS]

    meta_lines = []
    if video_meta:
        if video_meta.get("title"):
            meta_lines.append(f"Title: {video_meta['title']}")
        if video_meta.get("channel"):
            meta_lines.append(f"Channel: {video_meta['channel']}")
    meta_block = "\n".join(meta_lines)

    preamble = "Below is the transcript of a YouTube video."
    if meta_block:
        preamble += f"\n\nVideo info:\n{meta_block}"
    lang_name = _lang_code_to_name(lang)
    lang_instruction = (f"\n\nThe transcript is in {lang_name}. Write the questions in {lang_name}."
                        if lang else "\n\nWrite the questions in the SAME language as the transcript.")

    try:
        import json as _json
        client = _get_client()
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": SUGGESTED_QUESTIONS_PROMPT + lang_instruction},
                {"role": "user", "content": f"{preamble}\n\n{text}"},
            ],
            temperature=0.5,
            max_tokens=500,
            response_format={"type": "json_object"},
        )
        raw = response.choices[0].message.content.strip()
        data = _json.loads(raw)
        qs = data.get("questions", [])
        # Drop empties / non-strings; cap at 10 to bound payload size.
        out = [str(q).strip() for q in qs if isinstance(q, str) and q.strip()]
        return out[:10]
    except Exception as e:
        logger.warning("[SUMMARIZE] suggest_questions failed: %s", e)
        return []
