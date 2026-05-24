"""
RecapShark Translation Service
Translates video content (summary, chapters, transcript) via GPT.
Single responsibility: translation prompts and GPT calls.
"""

import json
import logging
import re

from langs import lang_code_to_name as _lang_name


logger = logging.getLogger(__name__)


# ── Model tiering ────────────────────────────────────────────
# Single source of truth lives in `pipeline.langs` as `ADVANCED_MODEL_LANGS`.
# Re-aliased here as `TIER_4O_LANGS` for back-compat with existing call sites
# inside this module.
from langs import ADVANCED_MODEL_LANGS as TIER_4O_LANGS  # noqa: E402


def _model_for_lang(target_lang: str) -> str:
    """Pick the best model for a target language."""
    model = "gpt-4o" if target_lang in TIER_4O_LANGS else "gpt-4o-mini"
    if model == "gpt-4o":
        logger.info("[TRANSLATE] Using gpt-4o for %s (%s) — tier upgrade", _lang_name(target_lang), target_lang)
    return model


# Per-OpenAI-call timeout (seconds) for translate_transcript_json. Advanced
# (TIER_4O_LANGS) langs route to gpt-4o which is meaningfully slower per call,
# especially on low-resource scripts (Amharic/Tigrinya/Tibetan/Wolof). The old
# hardcoded 20s timeout meant every chunk for those langs hit all 3 retries
# and 500'd, leaving the frontend cache empty → no translated transcript or
# subtitles. 60s gives gpt-4o enough headroom; non-advanced langs that go
# through this path (rare — they normally hit Google) keep 20s.
_TRANSCRIPT_JSON_TIMEOUT_DEFAULT = 20.0
_TRANSCRIPT_JSON_TIMEOUT_ADVANCED = 60.0


def _transcript_json_timeout_for_lang(target_lang: str) -> float:
    return (_TRANSCRIPT_JSON_TIMEOUT_ADVANCED
            if target_lang in TIER_4O_LANGS
            else _TRANSCRIPT_JSON_TIMEOUT_DEFAULT)


# ── Prompts ──────────────────────────────────────────────────
# System messages are kept short to reduce prompt leak risk.
# Rules are embedded in the user message alongside the content.

_SUMMARY_SYSTEM = "You are a translator. Output ONLY the translation, nothing else."

_SUMMARY_USER = (
    "Translate this video summary from {source} to {target}.\n"
    "Rules:\n"
    "- Text inside <name>...</name> tags is a proper name. Do NOT translate it. Keep the tags and the original text inside unchanged.\n"
    "- Text inside <term>...</term> tags is a key concept. Translate the text inside naturally, but KEEP the <term></term> tags around it.\n"
    "- Text inside <date>...</date> tags is a date or time period. Translate the text inside naturally, but KEEP the <date></date> tags around it.\n"
    "- Keep the same paragraph structure.\n"
    "- Keep 'Context:' prefix in English.\n"
    "- Translate naturally with a casual friendly tone.\n"
    "- Do not add or remove content.\n\n"
    "---\n{text}\n---"
)

_CHAPTERS_SYSTEM = "You are a translator. Return ONLY valid JSON, nothing else."

_CHAPTERS_USER = (
    "Translate these chapter titles from {source} to {target}.\n"
    "Rules: translate each title naturally (3-8 words), do NOT change start_time values.\n"
    'Return JSON: {{"chapters": [{{"title": string, "start_time": number}}, ...]}}\n\n'
    "{text}"
)

# ── Prompt leak detection ────────────────────────────────────
# Phrases that should never appear in translated output.

_LEAK_PHRASES = [
    "CRITICAL RULES:",
    "Preserve ALL markup",
    "Do NOT add or remove",
    "translate naturally",
    "Keep the same paragraph structure",
    "Output ONLY the translation",
    "Output ONLY the translated lines",
    "You are a translator",
    "You are a professional translator",
    "Return ONLY valid JSON",
    "casual friendly tone",
    "word-for-word",
    "<name>",
    "<term>",
    "<date>",
    "Do NOT translate it",
    "Keep the tags",
]

_LEAK_PATTERN = re.compile(
    "|".join(re.escape(p) for p in _LEAK_PHRASES),
    re.IGNORECASE,
)


def _strip_prompt_leak(text: str) -> str:
    """Remove any leaked prompt instructions from model output."""
    if not _LEAK_PATTERN.search(text):
        return text

    lines = text.split("\n")
    cleaned = []
    for line in lines:
        if _LEAK_PATTERN.search(line):
            continue
        cleaned.append(line)

    result = "\n".join(cleaned).strip()
    # If we stripped too aggressively (removed everything), return original
    return result if result else text


# ── Repetition detection ─────────────────────────────────────

_REPEAT_RE = re.compile(r"(\S+(?:\s+\S+){0,2}?)(?:\s+\1){4,}", re.UNICODE)


def _fix_repetition(text: str) -> str:
    """Truncate degenerate repetition loops (same word/phrase 5+ times)."""
    return _REPEAT_RE.sub(r"\1 \1 \1...", text)


# ── XML marker helpers for summary translation ──────────────

_NAME_RE = re.compile(r"\[\[([^\]]+)\]\]")
_TERM_RE = re.compile(r"\*\*([^*]+)\*\*")
_DATE_RE = re.compile(r"%%([^%]+)%%")


def _markers_to_xml(text: str) -> str:
    """Convert [[Name]] → <name>Name</name>, **Term** → <term>Term</term>, %%Date%% → <date>Date</date>."""
    text = _NAME_RE.sub(r"<name>\1</name>", text)
    text = _DATE_RE.sub(r"<date>\1</date>", text)
    text = _TERM_RE.sub(r"<term>\1</term>", text)
    return text


def _xml_to_markers(text: str) -> str:
    """Convert XML tags back to markdown markers."""
    text = re.sub(r"<name>(.*?)</name>", r"[[\1]]", text)
    text = re.sub(r"<date>(.*?)</date>", r"%%\1%%", text)
    text = re.sub(r"<term>(.*?)</term>", r"**\1**", text)
    return text


def _validate_marker_counts(original: str, translated: str) -> None:
    """Log warning if marker counts differ between original and translated text."""
    orig_names = len(_NAME_RE.findall(original))
    orig_terms = len(_TERM_RE.findall(original))
    orig_dates = len(_DATE_RE.findall(original))
    trans_names = len(_NAME_RE.findall(translated))
    trans_terms = len(_TERM_RE.findall(translated))
    trans_dates = len(_DATE_RE.findall(translated))
    if orig_names != trans_names or orig_terms != trans_terms or orig_dates != trans_dates:
        logger.warning(
            "[TRANSLATE:summary] marker mismatch — original %d names/%d terms/%d dates, "
            "translated %d names/%d terms/%d dates",
            orig_names, orig_terms, orig_dates, trans_names, trans_terms, trans_dates,
        )


def check_quality(original: str, translated: str) -> dict:
    """Check translation quality. Returns {ok: bool, warning: str|None}."""
    if not original.strip() or not translated.strip():
        return {"ok": True, "warning": None}

    # Check for repetition remnants (even after fix, if ≥30% is "..." lines)
    lines = translated.split("\n")
    ellipsis_lines = sum(1 for l in lines if l.rstrip().endswith("..."))
    if len(lines) > 2 and ellipsis_lines / len(lines) > 0.3:
        return {"ok": False, "warning": "low_quality"}

    # Check length ratio — if translated is >3x or <0.15x the original, suspicious
    ratio = len(translated) / max(len(original), 1)
    if ratio > 3.0 or ratio < 0.15:
        return {"ok": False, "warning": "low_quality"}

    return {"ok": True, "warning": None}


# ── Translation functions ────────────────────────────────────

_TITLE_SYSTEM = "You are a translator. Output ONLY the translation, nothing else."

_TITLE_USER = (
    "Translate this video title from {source} to {target}.\n"
    "Rules: output ONLY the translated title, one line, no explanations, "
    "no 'Context:', no extra text. Strip any [[brackets]] around names.\n\n"
    "{text}"
)


def translate_title(client, title_text: str,
                    source_lang: str, target_lang: str) -> str:
    """Translate a video title with a minimal prompt to avoid hallucination."""
    if not title_text.strip():
        return ""

    user_msg = _TITLE_USER.format(
        source=_lang_name(source_lang),
        target=_lang_name(target_lang),
        text=title_text,
    )

    response = client.chat.completions.create(
        model=_model_for_lang(target_lang),
        messages=[
            {"role": "system", "content": _TITLE_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.2,
        max_tokens=200,
    )
    result = response.choices[0].message.content.strip()
    # Strip any [[brackets]] the LLM may have preserved
    result = re.sub(r"\[\[([^\]]+)\]\]", r"\1", result)
    result = _strip_prompt_leak(result)
    result = _fix_repetition(result)
    return result


def translate_summary(client, summary_text: str,
                      source_lang: str, target_lang: str) -> str:
    """Translate a video summary, preserving [[name]] and **term** markup."""
    if not summary_text.strip():
        return ""

    # Convert markers to XML tags — LLMs preserve these more reliably
    xml_text = _markers_to_xml(summary_text)

    user_msg = _SUMMARY_USER.format(
        source=_lang_name(source_lang),
        target=_lang_name(target_lang),
        text=xml_text,
    )

    response = client.chat.completions.create(
        model=_model_for_lang(target_lang),
        messages=[
            {"role": "system", "content": _SUMMARY_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.2,
        max_tokens=1500,
    )
    result = response.choices[0].message.content.strip()
    # Strip the --- delimiters if the model echoed them
    result = re.sub(r"^---\s*\n?", "", result)
    result = re.sub(r"\n?---\s*$", "", result)
    # Convert XML tags back to markdown markers
    result = _xml_to_markers(result)
    result = _strip_prompt_leak(result)
    result = _fix_repetition(result)
    # Validate marker preservation
    _validate_marker_counts(summary_text, result)
    return result


def translate_chapters(client, chapters: list[dict],
                       source_lang: str, target_lang: str) -> list[dict]:
    """Translate chapter titles, preserving start_time values."""
    if not chapters:
        return []

    user_msg = _CHAPTERS_USER.format(
        source=_lang_name(source_lang),
        target=_lang_name(target_lang),
        text=json.dumps({"chapters": chapters}, ensure_ascii=False),
    )

    # Wrap the OpenAI call with an explicit per-call timeout. Without this,
    # the call can hang on the OpenAI client's library default (which is
    # generous and shared across requests); for advanced langs running on
    # gpt-4o that meant chapters could silently sit forever and never
    # populate cache.chapters in the frontend, so the panel kept showing
    # the original-lang chapters even though title/summary had translated.
    # 45s is enough for ~10–20 chapter titles on gpt-4o; gpt-4o-mini for
    # normal langs finishes in well under 10s so the cap is harmless there.
    from openai import OpenAI
    call_client = OpenAI(
        api_key=client.api_key,
        timeout=45.0,
        max_retries=0,
    )
    response = call_client.chat.completions.create(
        model=_model_for_lang(target_lang),
        messages=[
            {"role": "system", "content": _CHAPTERS_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.2,
        max_tokens=800,
        response_format={"type": "json_object"},
    )
    data = json.loads(response.choices[0].message.content.strip())
    return data.get("chapters", [])


# ── JSON-based transcript translation ─────────────────────────

_TRANSCRIPT_JSON_SYSTEM = (
    "You are a professional translator. You translate text accurately and "
    "naturally. You always respond with valid JSON and nothing else."
)

_TRANSCRIPT_JSON_USER = (
    "Translate each line from {source} to {target}.\n\n"
    "Input JSON:\n{text}\n\n"
    "Return a JSON object with this exact structure:\n"
    '{{\"lines\": [{{\"id\": <same id>, \"text\": \"<translated text>\"}}]}}\n\n'
    "Rules:\n"
    "- Translate every \"text\" value naturally and completely.\n"
    "- Preserve every \"id\" exactly. Do not reorder, merge, or omit items.\n"
    "- Return ONLY the JSON object. No markdown, no explanation, no preamble."
)

# Markdown fence pattern for stripping ```json ... ``` wrappers
_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _parse_json_response(raw: str) -> dict:
    """Parse JSON from model response, stripping markdown fences if present."""
    text = raw.strip()
    m = _JSON_FENCE_RE.match(text)
    if m:
        text = m.group(1).strip()
    return json.loads(text)


def _validate_json_translation(data: dict, input_lines: list[dict],
                                target_lang: str) -> str | None:
    """Validate translated JSON response. Returns error string or None if OK."""
    if not isinstance(data, dict) or "lines" not in data:
        return "missing 'lines' key"
    result = data["lines"]
    if not isinstance(result, list):
        return "'lines' is not a list"
    if len(result) != len(input_lines):
        return f"item count mismatch: got {len(result)}, expected {len(input_lines)}"
    input_ids = {item["id"] for item in input_lines}
    output_ids = {item.get("id") for item in result}
    if input_ids != output_ids:
        return f"id mismatch: expected {input_ids}, got {output_ids}"
    for item in result:
        if not item.get("text", "").strip():
            return f"empty text for id {item.get('id')}"
    return None


def _extract_partial(data: dict, input_lines: list[dict]) -> list[dict] | None:
    """Extract valid lines from a response that failed strict validation."""
    if not isinstance(data, dict) or "lines" not in data:
        return None
    result = data["lines"]
    if not isinstance(result, list):
        return None
    input_ids = {item["id"] for item in input_lines}
    matched = [item for item in result
               if isinstance(item, dict) and item.get("id") in input_ids
               and item.get("text", "").strip()]
    return matched if matched else None


def translate_transcript_json(client, lines: list[dict],
                              source_lang: str, target_lang: str,
                              timeout: float = None, model: str = None,
                              temperature: float = 0.3,
                              retries: int = 3) -> list[dict]:
    """Translate transcript lines using JSON input/output format.
    No response_format constraint — validates response ourselves.
    Retries with temperature escalation on timeout.

    `timeout` is per-OpenAI-call (not per-route). When None we resolve a
    lang-aware default: 20s for normal langs, 60s for advanced (gpt-4o)
    langs. The old hard 20s caused every Amharic / Tibetan / etc. chunk
    to hit all 3 retries and 500 the route, leaving the frontend with an
    empty transcriptMap and so no translated transcript or subtitles.
    """
    if not lines:
        return []

    if timeout is None:
        timeout = _transcript_json_timeout_for_lang(target_lang)

    use_model = model or _model_for_lang(target_lang)
    payload = json.dumps({"lines": lines}, ensure_ascii=False)

    user_msg = _TRANSCRIPT_JSON_USER.format(
        source=_lang_name(source_lang),
        target=_lang_name(target_lang),
        text=payload,
    )

    from openai import OpenAI
    call_client = OpenAI(
        api_key=client.api_key,
        timeout=timeout,
        max_retries=0,
    )

    last_err = None
    best_partial = None
    temp = temperature
    for attempt in range(1, retries + 1):
        try:
            logger.info("[TRANSLATE:json] Attempt %d/%d, model=%s, temp=%.2f, timeout=%ds", attempt, retries, use_model, temp, timeout)
            response = call_client.chat.completions.create(
                model=use_model,
                messages=[
                    {"role": "system", "content": _TRANSCRIPT_JSON_SYSTEM},
                    {"role": "user", "content": user_msg},
                ],
                temperature=temp,
                max_tokens=8192,
            )

            raw = response.choices[0].message.content.strip()
            try:
                data = _parse_json_response(raw)
            except json.JSONDecodeError as je:
                logger.warning("[TRANSLATE:json] Attempt %d bad JSON: %s", attempt, je)
                last_err = je
                continue

            err = _validate_json_translation(data, lines, target_lang)
            if err:
                logger.warning("[TRANSLATE:json] Attempt %d validation failed: %s", attempt, err)
                last_err = ValueError(err)
                partial = _extract_partial(data, lines)
                if partial and (not best_partial or len(partial) > len(best_partial)):
                    best_partial = partial
                continue

            result_lines = data["lines"]
            for item in result_lines:
                if "text" in item:
                    item["text"] = _fix_repetition(item["text"])

            logger.info("[TRANSLATE:json] Attempt %d succeeded, %d lines", attempt, len(result_lines))
            return result_lines

        except Exception as e:
            last_err = e
            logger.warning("[TRANSLATE:json] Attempt %d/%d failed: %s", attempt, retries, e)
            temp = min(temp + 0.1, 0.6)

    if best_partial:
        for item in best_partial:
            if "text" in item:
                item["text"] = _fix_repetition(item["text"])
        logger.warning("[TRANSLATE:json] All retries failed, using best partial: %d/%d lines", len(best_partial), len(lines))
        return best_partial

    raise last_err if last_err else RuntimeError("translate_transcript_json exhausted retries")


