"""
LLM prompt templates for the summary, chapter, chat, and title-color
pipelines.

Single source of truth — all OpenAI calls in the pipeline import from
this module. Extracted from `worker.py` and `summarize.py` so prompt
iteration doesn't require touching the orchestration code, and so drift
between casual / formal tones lives in one file instead of spread across
600+ LOC of helpers.

Note: prompts in this file are stripped-down placeholders. Production
prompts contain proprietary instruction-tuning details (highlight markup
schemes, voice-specific rules, multi-language guidance, few-shot examples)
and aren't shared in this code-review sample. The module shape — constant
names, format-string templates, casual/formal split, public vs underscored
visibility — matches production exactly so call sites import unmodified.
"""


# ─────────────────────────────────────────────────────────────────────
# Summary prompts (formerly summarize.py)
# ─────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "Summarize a YouTube video transcript in 3-5 paragraphs. "
    "Keep it accurate, plain-language, and well-structured. "
    "You will be given video metadata (title, channel, date) along with the transcript."
)


CASUAL_SYSTEM_PROMPT = (
    "Summarize a YouTube video transcript in 3-5 paragraphs with a "
    "casual, conversational voice. Same accuracy as the formal variant."
)


SUGGESTED_QUESTIONS_PROMPT = (
    "Given a video transcript, generate 10 short follow-up questions a "
    "viewer might tap to ask an assistant. Each question must be specific "
    "to the video (reference a concrete person, claim, number, or moment). "
    "Return ONLY JSON: {\"questions\": [\"q1\", ..., \"q10\"]}."
)


# ─────────────────────────────────────────────────────────────────────
# Chapter prompts — voice fragment shared by 3 casual variants
# (formerly worker.py)
# ─────────────────────────────────────────────────────────────────────

_CASUAL_CHAPTER_VOICE = (
    "Casual-voice instruction shared by the chapter-generation prompts. "
    "Same accuracy as the formal variant.\n\n"
)


_CASUAL_FAST_CHAPTERS_PROMPT = (
    _CASUAL_CHAPTER_VOICE +
    "Given a timestamped transcript, identify 4-8 main topic shifts. "
    "Return ONLY JSON: "
    "{\"chapters\": [{\"title\": str (3-8 words), \"start_time\": int (seconds)}, ...]}."
)


_CASUAL_CHAPTERS_V2_PROMPT = (
    _CASUAL_CHAPTER_VOICE +
    "Generate YouTube-style chapters that span the full video. First "
    "chapter at start_time=0. Each title 3-8 words. start_time in seconds. "
    "Return JSON: {\"chapters\": [{\"title\": str, \"start_time\": int}, ...]}."
)


_CASUAL_REDUCE_PROMPT = (
    _CASUAL_CHAPTER_VOICE +
    "Given topic anchors with timestamps and distinctness scores (1-10), "
    "select 10-15 final chapters. First chapter at 0. Last chapter at "
    ">= {last_chapter_min} seconds. Total duration: {total_seconds} seconds. "
    "Return JSON: {{\"chapters\": [{{\"title\": str, \"start_time\": int}}, ...]}}."
)


_FAST_SUMMARY_PROMPT = (
    "Summarize this transcript in 2-3 sentences. Plain language."
)


_FAST_CHAPTERS_PROMPT = (
    "Identify 4-8 topic shifts in the transcript. Return JSON: "
    "{\"chapters\": [{\"title\": str, \"start_time\": int}, ...]}."
)


_CHAPTERS_V2_PROMPT = (
    "Generate YouTube-style chapters across the full video. First chapter "
    "at start_time=0. Each title 3-8 words. start_time in seconds. "
    "Return JSON: {\"chapters\": [{\"title\": str, \"start_time\": int}, ...]}."
)


_MAP_PROMPT = (
    "Analyze one section of a transcript. Identify every topic shift "
    "(2-4 typical). For each: topic (3-8 words), start_time (seconds, "
    "from the transcript), score (1-10, how distinct from previous). "
    "Return JSON: {{\"shifts\": [{{\"topic\": str, \"start_time\": int, \"score\": int}}, ...]}}."
)


_REDUCE_PROMPT = (
    "Select final YouTube-style chapters from topic anchors. "
    "10-15 chapters. First chapter at 0. Last chapter at "
    ">= {last_chapter_min} seconds. Total duration: {total_seconds} seconds. "
    "Return JSON: {{\"chapters\": [{{\"title\": str, \"start_time\": int}}, ...]}}."
)


# ─────────────────────────────────────────────────────────────────────
# Chat prompts (formerly worker.py)
# ─────────────────────────────────────────────────────────────────────

_CHAT_PROMPT = (
    "You answer questions about a YouTube video the user just watched. "
    "Every response MUST include at least one inline [MM:SS] or [H:MM:SS] "
    "timestamp copied from the transcript (never invented). Keep answers "
    "short. Return JSON: {\"answer\": str, \"context\": str}."
)


_CASUAL_CHAT_OVERLAY = (
    "Tone overlay: same factual accuracy, but deliver the answer in a "
    "casual, blunt voice. Do not sacrifice specificity for tone."
)


# ─────────────────────────────────────────────────────────────────────
# Title-colors prompt (formerly worker.py)
# ─────────────────────────────────────────────────────────────────────

_TITLE_COLORS_PROMPT = (
    "Split a YouTube title into ordered text segments and assign each a "
    "color: 'black', 'red', 'yellow', or 'cyan'. Exactly 1 red + 1 yellow "
    "segment, each with trimmed text >= 3 characters. Hashtags are 'cyan'. "
    "Concatenating segments must reproduce the original title exactly. "
    "Return JSON: {\"logic\": str, \"segments\": [...]}"
)


# ─────────────────────────────────────────────────────────────────────
# Formal-rewrite prompts (formerly worker.py)
# ─────────────────────────────────────────────────────────────────────

_FORMAL_SUMMARY_PROMPT = (
    "Rewrite a casual video summary in a clean, neutral, professional tone. "
    "Preserve [[name]], **term**, %%date%% markers exactly. Keep all "
    "original facts and the paragraph structure. Output only the rewritten "
    "text."
)


_FORMAL_CHAPTERS_PROMPT = (
    "Rewrite chapter titles in a clean, professional tone. Keep the EXACT "
    "same start_time values. Return JSON: "
    "{\"chapters\": [{\"title\": str, \"start_time\": int}, ...]}."
)
