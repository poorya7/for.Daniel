"""
RecapShark Chat / Formal-Rewrite / Title-Colors service layer.

Extracts the business logic that previously lived inline in routes.py
handlers. Adds a structured upstream-error envelope for OpenAI failures:

- 429 `insufficient_quota` (billing limit hit) and 5xx (transient) →
  `UpstreamError` raised; route handler converts to HTTP 503 with
  `{"error": "upstream_quota_exceeded", "status": 503}` (or
  `upstream_unavailable` for 5xx).

The previous behavior returned bare HTTP 500 with the raw exception
string, which leaked internal detail and gave the frontend nothing
structured to act on. Frontend-side toast UX is intentionally a separate
follow-up — see `docs/_logs/REFACTOR_PLAN.md` Bundle 2 + Locked
Decision L5.
"""

import logging

from constants import CHAT_TRANSCRIPT_MAX_CHARS


logger = logging.getLogger(__name__)


class UpstreamError(Exception):
    """OpenAI (or other upstream LLM provider) returned a recoverable error.

    Caught at the route layer and converted to HTTP 503 with a structured
    body so the frontend can distinguish "we ran out of credits" from
    "something else broke".
    """

    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _classify_openai_error(exc: Exception) -> UpstreamError | None:
    """Map an OpenAI SDK exception to an UpstreamError, or None if not an
    upstream-side problem we want to surface as 503.

    The OpenAI SDK raises `openai.RateLimitError` for 429 (which includes
    `insufficient_quota` for billing-limit hits) and `openai.APIStatusError`
    subclasses for other HTTP-mapped failures. Rather than import every
    subclass individually (the hierarchy moved between SDK majors), we
    sniff the type name + message text — this stays stable across SDK
    upgrades and works the same for the older `openai.error.*` shape if
    the SDK is ever downgraded.
    """
    name = type(exc).__name__
    msg = str(exc).lower()

    if name == "RateLimitError" or "insufficient_quota" in msg or "rate limit" in msg:
        return UpstreamError(
            code="upstream_quota_exceeded",
            message="Upstream LLM provider rate-limited or out of quota",
        )

    # 5xx mapped exceptions (server-side, transient)
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if isinstance(status, int) and 500 <= status < 600:
        return UpstreamError(
            code="upstream_unavailable",
            message=f"Upstream LLM provider returned {status}",
        )
    if name in ("APIConnectionError", "APITimeoutError"):
        return UpstreamError(
            code="upstream_unavailable",
            message="Upstream LLM provider unreachable or timed out",
        )

    return None


# ── /chat business logic ─────────────────────────────────────────


def _build_timestamped_transcript(transcript_text: str, segments: list[dict]) -> str:
    """Return a timestamped transcript fitting under CHAT_TRANSCRIPT_MAX_CHARS.

    Two paths:
    - If the frontend already pre-formatted the transcript ([MM:SS] format),
      truncate and use as-is.
    - Otherwise, build from raw segments via geometric step-stride sampling
      until it fits the cap.
    """
    if transcript_text:
        timestamped = transcript_text[:CHAT_TRANSCRIPT_MAX_CHARS]
        logger.info("[CHAT] using pre-formatted transcript, length=%d chars", len(timestamped))
        return timestamped

    step = 1
    while True:
        timestamped = "\n".join(
            f"[{int(s.get('start', 0))}s] {s.get('text', '')}"
            for s in segments[::step] if s.get("text")
        )
        if len(timestamped) <= CHAT_TRANSCRIPT_MAX_CHARS or step > 20:
            break
        step += 1
    logger.info("[CHAT] built from segments, length=%d chars, step=%d",
                len(timestamped), step)
    return timestamped


def answer_chat(req, ip: str = "?") -> dict:
    """Answer a user question about the video using the full transcript.

    Raises UpstreamError on OpenAI quota / 5xx so the route layer can
    return a structured 503; other exceptions propagate to the route
    layer's generic 500 handler.
    """
    from openai_client import get_client as _get_client
    from worker import _call_chat

    logger.info(
        "[CHAT] segments=%d, question=%r, history=%d, casual=%s, ip=%s",
        len(req.segments), req.question, len(req.history), req.casual, ip,
    )

    timestamped = _build_timestamped_transcript(req.transcript_text, req.segments)

    try:
        client = _get_client()
        answer = _call_chat(
            client, timestamped, req.question, req.history, req.lang,
            req.video_lang, req.video_duration, req.video_title,
            req.video_channel, req.summary, casual=req.casual,
        )
        return {"answer": answer}
    except Exception as exc:
        upstream = _classify_openai_error(exc)
        if upstream:
            logger.warning("[CHAT] upstream error: %s — %s", upstream.code, exc)
            raise upstream from exc
        raise


# ── /formal-rewrite business logic ───────────────────────────────


def formal_rewrite(req) -> dict:
    """Rewrite summary and chapters in formal/professional tone.

    Same upstream-error contract as `answer_chat`.
    """
    from openai_client import get_client as _get_client
    from worker import _call_formal_summary, _call_formal_chapters

    raw_body = req.model_extra or {}
    custom_prompt = raw_body.get('_custom_prompt', '')
    model_override = raw_body.get('_model', '')

    try:
        client = _get_client()
        result = {}
        if req.summary:
            result["summary"] = _call_formal_summary(
                client, req.summary, req.lang,
                custom_prompt=custom_prompt, model_override=model_override,
            )
        if req.chapters:
            result["chapters"] = _call_formal_chapters(client, req.chapters, req.lang)
        return result
    except Exception as exc:
        upstream = _classify_openai_error(exc)
        if upstream:
            logger.warning("[FORMAL-REWRITE] upstream error: %s — %s", upstream.code, exc)
            raise upstream from exc
        raise


# ── /title-colors business logic ─────────────────────────────────


def title_colors(title: str, prompt_override: str | None = None) -> dict:
    """Return video title split into colored segments for brutalist theme."""
    from openai_client import get_client as _get_client
    from worker import _call_title_colors

    try:
        client = _get_client()
        return _call_title_colors(client, title, prompt_override=prompt_override)
    except Exception as exc:
        upstream = _classify_openai_error(exc)
        if upstream:
            logger.warning("[TITLE-COLORS] upstream error: %s — %s", upstream.code, exc)
            raise upstream from exc
        raise
