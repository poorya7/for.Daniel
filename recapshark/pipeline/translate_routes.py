"""
RecapShark Translate Routes
All /translate/* endpoints. Extracted from routes.py 2026-05-09 (Bundle 2 of
the Cleanup Follow-up plan). Pattern matches youtube_routes / transcript_routes
/ karaoke/routes.

Public functions (`check_quality`, `translate_summary`, `translate_chapters`,
`translate_title`, `translate_transcript_json`) are imported from `translate.py`.

Logging uses `logger.info` (not `print`), consistent with the Phase 4e sweep
across the rest of the backend. The `[TRANSLATE:*]` / `[GOOGLE-TRANSLATE:*]`
prefixes are preserved for pm2 log grep continuity.

Cost protection (added 2026-05-13): every Google Translate path goes through
`translate_protected.protected_translate_*` which layers a content-hash cache,
a global $/day kill-switch, and a per-IP char/day cap on top of the raw
google_translate calls. Cap hits return HTTP 429 with a structured error code
the frontend can switch on (`{"error_code": "global_daily_cap_hit"}` etc.) so
users see an informative message instead of a hung loading state.
"""

import logging
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from deps import limiter
from translate_protected import (
    CapAccountingUnavailableError,
    TranslateCapHitError,
)


def _client_ip(request: Request) -> str:
    """Best-effort caller IP. Honors X-Forwarded-For (set by nginx) so per-IP
    caps work behind the reverse proxy; falls back to the socket peer."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else ""


def _cap_hit_http(e: TranslateCapHitError) -> HTTPException:
    """Map a cap-hit to a structured HTTP 429 response. Frontend switches on
    `error_code` to show 'daily limit reached' immediately (not a spinner)."""
    msg = (
        "Daily translation limit reached for today. Try again tomorrow."
        if e.kind == "global_daily_cap_hit"
        else "You've used your daily translation allowance. Try again tomorrow."
    )
    return HTTPException(
        status_code=429,
        detail={"error_code": e.kind, "message": msg},
    )


def _cap_unavailable_http() -> HTTPException:
    """Map cap-accounting outage to HTTP 503. Frontend treats this like a
    transient backend error — retryable, but not "you hit your limit"."""
    return HTTPException(
        status_code=503,
        detail={
            "error_code": "translate_cap_accounting_unavailable",
            "message": "Translation service is briefly unavailable. Please try again in a moment.",
        },
    )


logger = logging.getLogger(__name__)

translate_router = APIRouter()


# ── Request models ──────────────────────────────────────────────


class TranslateSummaryRequest(BaseModel):
    text: str = ""
    source_lang: str = "en"
    target_lang: str = "es"


class TranslateChaptersRequest(BaseModel):
    chapters: list[dict] = []
    source_lang: str = "en"
    target_lang: str = "es"


class TranslateJsonRequest(BaseModel):
    lines: list[dict] = []
    source_lang: str = "en"
    target_lang: str = "es"
    model: str = ""
    temperature: float = 0.3
    retries: int = 3


class TranslateBulkRequest(BaseModel):
    lines: list[dict] = []
    source_lang: str = "en"
    target_lang: str = "fa"


class GoogleTranslateRequest(BaseModel):
    lines: list[dict] = []
    text: str = ""
    source_lang: str = "en"
    target_lang: str = "fa"


class TranslateJsonTwoHopRequest(BaseModel):
    lines: list[dict] = []
    source_lang: str = "it"
    target_lang: str = "am"
    temperature: float = 0.5
    retries: int = 1


# ── Routes ──────────────────────────────────────────────────────


@translate_router.post("/translate/title")
@limiter.limit("30/minute")
def translate_title_route(request: Request, req: TranslateSummaryRequest):
    """Translate video title — Google first, GPT fallback for advanced langs."""

    ip = _client_ip(request)
    logger.info("[TRANSLATE:title] %s -> %s, %dch, ip=%s",
                req.source_lang, req.target_lang, len(req.text), ip)
    try:
        from google_translate import is_google_lang
        from translate_protected import protected_translate_text
        if is_google_lang(req.target_lang):
            result = protected_translate_text(req.text, req.source_lang, req.target_lang, ip)
            logger.info("[GOOGLE-TRANSLATE:title] Done: %dch", len(result))
            return {"title": result}

        from openai_client import get_client as _get_client
        from translate import translate_title
        client = _get_client()
        result = translate_title(client, req.text, req.source_lang, req.target_lang)
        logger.info("[TRANSLATE:title] Done (GPT): %dch", len(result))
        return {"title": result}
    except TranslateCapHitError as e:
        raise _cap_hit_http(e)
    except CapAccountingUnavailableError:
        raise _cap_unavailable_http()
    except Exception as e:
        logger.warning("[TRANSLATE:title] ERROR: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@translate_router.post("/translate/summary")
@limiter.limit("30/minute")
def translate_summary_route(request: Request, req: TranslateSummaryRequest):
    """Translate video summary — always GPT for natural, context-aware translations."""

    logger.info("[TRANSLATE:summary] %s -> %s, %dch (GPT)",
                req.source_lang, req.target_lang, len(req.text))
    try:
        from openai_client import get_client as _get_client
        from translate import translate_summary, check_quality
        client = _get_client()
        result = translate_summary(client, req.text, req.source_lang, req.target_lang)
        quality = check_quality(req.text, result)
        logger.info("[TRANSLATE:summary] Done (GPT): %dch, quality=%s",
                    len(result), quality)
        return {"summary": result, "warning": quality.get("warning")}
    except Exception as e:
        logger.warning("[TRANSLATE:summary] ERROR: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@translate_router.post("/translate/chapters")
@limiter.limit("30/minute")
def translate_chapters_route(request: Request, req: TranslateChaptersRequest):
    """Translate chapter titles — Google first, GPT fallback for advanced langs."""

    ip = _client_ip(request)
    logger.info("[TRANSLATE:chapters] %s -> %s, %d chapters",
                req.source_lang, req.target_lang, len(req.chapters))
    try:
        from google_translate import is_google_lang
        from translate_protected import protected_translate_lines
        if is_google_lang(req.target_lang):
            # Batch all chapter titles in one API call
            lines = [{'id': i, 'text': ch.get('title', '')} for i, ch in enumerate(req.chapters)]
            translated = protected_translate_lines(lines, req.source_lang, req.target_lang, ip)
            result = []
            for i, ch in enumerate(req.chapters):
                result.append({**ch, 'title': translated[i]['text'] if i < len(translated) else ch.get('title', '')})
            logger.info("[GOOGLE-TRANSLATE:chapters] Done: %d chapters", len(result))
            return {"chapters": result}

        from openai_client import get_client as _get_client
        from translate import translate_chapters
        client = _get_client()
        result = translate_chapters(client, req.chapters, req.source_lang, req.target_lang)
        logger.info("[TRANSLATE:chapters] Done (GPT): %d chapters", len(result))
        return {"chapters": result}
    except TranslateCapHitError as e:
        raise _cap_hit_http(e)
    except CapAccountingUnavailableError:
        raise _cap_unavailable_http()
    except Exception as e:
        logger.warning("[TRANSLATE:chapters] ERROR: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@translate_router.post("/translate/transcript-json")
@limiter.limit("200/minute")
def translate_transcript_json_route(request: Request, req: TranslateJsonRequest):
    """Translate transcript lines — Google first, GPT fallback for advanced langs."""

    model_override = req.model if req.model else None
    ip = _client_ip(request)
    t0 = time.time()
    try:
        # Google path — fast, for non-advanced languages
        from google_translate import is_google_lang
        from translate_protected import protected_translate_lines
        if is_google_lang(req.target_lang) and not model_override:
            logger.info("[GOOGLE-TRANSLATE:json] %s -> %s, %d lines",
                        req.source_lang, req.target_lang, len(req.lines))
            result = protected_translate_lines(req.lines, req.source_lang, req.target_lang, ip)
            elapsed = time.time() - t0
            logger.info("[GOOGLE-TRANSLATE:json] Done in %.1fs: %d lines",
                        elapsed, len(result))
            return {"lines": result}

        # GPT path — for advanced languages or explicit model override
        temp = max(0.0, min(req.temperature, 2.0))
        retries = max(1, min(req.retries, 5))
        logger.info("[TRANSLATE:json] %s -> %s, %d lines, model=%s, temp=%s, retries=%d",
                    req.source_lang, req.target_lang, len(req.lines),
                    model_override or 'default', temp, retries)

        from openai_client import get_client as _get_client
        from translate import translate_transcript_json, check_quality

        client = _get_client()
        result = translate_transcript_json(
            client, req.lines, req.source_lang, req.target_lang,
            model=model_override, temperature=temp, retries=retries,
        )
        elapsed = time.time() - t0

        orig_text = " ".join(item.get("text", "") for item in req.lines)
        trans_text = " ".join(item.get("text", "") for item in result)
        quality = check_quality(orig_text, trans_text)

        logger.info("[TRANSLATE:json] Done in %.1fs (GPT): %d lines, quality=%s",
                    elapsed, len(result), quality)
        return {"lines": result, "warning": quality.get("warning")}
    except TranslateCapHitError as e:
        raise _cap_hit_http(e)
    except CapAccountingUnavailableError:
        raise _cap_unavailable_http()
    except Exception as e:
        elapsed = time.time() - t0
        logger.warning("[TRANSLATE:json] ERROR after %.1fs: %s", elapsed, e)
        raise HTTPException(status_code=500, detail=str(e))


@translate_router.post("/translate/transcript-bulk")
@limiter.limit("30/minute")
def translate_transcript_bulk_route(request: Request, req: TranslateBulkRequest):
    """Translate entire transcript in one shot via Google. Falls back to chunked GPT for advanced langs."""
    ip = _client_ip(request)
    t0 = time.time()
    try:
        from google_translate import is_google_lang
        from translate_protected import protected_translate_lines
        if is_google_lang(req.target_lang):
            logger.info("[GOOGLE-TRANSLATE:bulk] %s -> %s, %d lines",
                        req.source_lang, req.target_lang, len(req.lines))
            result = protected_translate_lines(req.lines, req.source_lang, req.target_lang, ip)
            elapsed = time.time() - t0
            logger.info("[GOOGLE-TRANSLATE:bulk] Done in %.1fs: %d lines",
                        elapsed, len(result))
            return {"lines": result, "engine": "google"}
        else:
            # Not a Google language — return signal for frontend to fall back to chunked GPT
            return {"fallback": True, "engine": "gpt"}
    except TranslateCapHitError as e:
        raise _cap_hit_http(e)
    except CapAccountingUnavailableError:
        raise _cap_unavailable_http()
    except Exception as e:
        elapsed = time.time() - t0
        logger.warning("[GOOGLE-TRANSLATE:bulk] ERROR after %.1fs: %s", elapsed, e)
        raise HTTPException(status_code=500, detail=str(e))


@translate_router.post("/translate/google")
@limiter.limit("60/minute")
def translate_google_route(request: Request, req: GoogleTranslateRequest):
    """Translate via Google Cloud Translation API (fast, for non-advanced languages)."""
    ip = _client_ip(request)
    t0 = time.time()
    try:
        from translate_protected import protected_translate_text, protected_translate_lines
        if req.lines:
            logger.info("[GOOGLE-TRANSLATE] %s -> %s, %d lines",
                        req.source_lang, req.target_lang, len(req.lines))
            result = protected_translate_lines(req.lines, req.source_lang, req.target_lang, ip)
            elapsed = time.time() - t0
            logger.info("[GOOGLE-TRANSLATE] Done in %.1fs: %d lines",
                        elapsed, len(result))
            return {"lines": result}
        elif req.text:
            logger.info("[GOOGLE-TRANSLATE] %s -> %s, text (%d chars)",
                        req.source_lang, req.target_lang, len(req.text))
            translated = protected_translate_text(req.text, req.source_lang, req.target_lang, ip)
            elapsed = time.time() - t0
            logger.info("[GOOGLE-TRANSLATE] Done in %.1fs", elapsed)
            return {"text": translated}
        else:
            raise HTTPException(status_code=400, detail="Provide 'lines' or 'text'")
    except TranslateCapHitError as e:
        raise _cap_hit_http(e)
    except CapAccountingUnavailableError:
        raise _cap_unavailable_http()
    except Exception as e:
        elapsed = time.time() - t0
        logger.warning("[GOOGLE-TRANSLATE] ERROR after %.1fs: %s", elapsed, e)
        raise HTTPException(status_code=500, detail=str(e))


@translate_router.post("/translate/transcript-json-twohop")
@limiter.limit("60/minute")
def translate_transcript_json_twohop_route(request: Request, req: TranslateJsonTwoHopRequest):
    """Two-hop translation: source -> English -> target, using gpt-4o-mini for both hops."""

    temp = max(0.0, min(req.temperature, 2.0))
    retries = max(1, min(req.retries, 5))
    logger.info("[TRANSLATE:twohop] %s -> en -> %s, %d lines, temp=%s",
                req.source_lang, req.target_lang, len(req.lines), temp)
    t0 = time.time()
    try:
        from openai_client import get_client as _get_client
        from translate import translate_transcript_json

        client = _get_client()

        # Hop 1: source -> English (fast, reliable)
        logger.info("[TRANSLATE:twohop] Hop 1: %s -> en", req.source_lang)
        english_lines = translate_transcript_json(
            client, req.lines, req.source_lang, "en",
            model="gpt-4o-mini", temperature=temp, retries=retries, timeout=20.0,
        )

        # Hop 2: English -> target (the harder step)
        logger.info("[TRANSLATE:twohop] Hop 2: en -> %s", req.target_lang)
        final_lines = translate_transcript_json(
            client, english_lines, "en", req.target_lang,
            model="gpt-4o-mini", temperature=temp, retries=retries, timeout=20.0,
        )

        elapsed = time.time() - t0
        logger.info("[TRANSLATE:twohop] Done in %.1fs: %d lines",
                    elapsed, len(final_lines))
        return {"lines": final_lines}
    except Exception as e:
        elapsed = time.time() - t0
        logger.warning("[TRANSLATE:twohop] ERROR after %.1fs: %s", elapsed, e)
        raise HTTPException(status_code=500, detail=str(e))
