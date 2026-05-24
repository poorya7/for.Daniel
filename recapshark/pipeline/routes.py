"""
RecapShark API Routes
Thin aggregator: mounts every domain sub-router and keeps a small surface
of cross-cutting endpoints (`/health`, `/chat`, `/formal-rewrite`,
`/title-colors`, summary-tone-test) that don't fit one domain.

Bundle 2 of the post-Phase-6 cleanup follow-up (2026-05-09) extracted the
8 `/translate/*` handlers into `translate_routes.py` (now mounted via
`include_router(translate_router)`) and pushed the chat /
formal-rewrite / title-colors business logic into `chat_service.py` so
the handlers below stay one-screen-tall and the OpenAI exception paths
return a structured 503 envelope instead of bare 500. See
`docs/_logs/REFACTOR_PLAN.md` § Bundle 2 for the full rationale.
"""

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from deps import limiter

# Sub-routers
from youtube_routes import youtube_router
from karaoke import asr_provider_router
from transcript_routes import transcript_router
from analytics import router as bq_analytics_router
from owner_routes import router as owner_router
from chat_log_routes import router as chat_log_router
from entity_routes import router as entity_router
from test_routes import test_router
from translate_routes import translate_router
from debug_routes import debug_router

# Service layer
from chat_service import UpstreamError


logger = logging.getLogger(__name__)

router = APIRouter()
router.include_router(youtube_router)
router.include_router(asr_provider_router)
router.include_router(transcript_router)
router.include_router(bq_analytics_router)
router.include_router(owner_router)
router.include_router(chat_log_router)
router.include_router(entity_router)
router.include_router(test_router)
router.include_router(translate_router)
router.include_router(debug_router)


@router.get("/health")
def health():
    return {"status": "ok"}


# `ShortSummaryRequest`, `FullSummaryRequest`, `ChaptersV2Request` and the
# six `/test/*` route handlers that consumed them moved to `test_routes.py`
# in Phase 4a A4 (2026-05-08). They remain mounted on this aggregator
# router via `router.include_router(test_router)` above; behavior is
# byte-identical (same paths, same rate limits, same Pydantic shapes).


def _upstream_error_response(exc: UpstreamError) -> JSONResponse:
    """Convert an UpstreamError raised by the service layer into the
    structured envelope the frontend can branch on. Single helper so
    every handler returns the same shape."""
    return JSONResponse(
        status_code=exc.status,
        content={"error": exc.code, "status": exc.status, "detail": exc.message},
    )


class ChatRequest(BaseModel):
    transcript_text: str
    segments: list[dict]
    question: str
    history: list[dict] = []
    lang: str = "en"
    video_lang: str = ""
    video_duration: float = 0
    video_title: str = ""
    video_channel: str = ""
    summary: str = ""
    casual: bool = False


@router.post("/chat")
@limiter.limit("30/minute")
def chat(request: Request, req: ChatRequest):
    """Answer a user question about the video using the full transcript."""
    from chat_service import answer_chat

    ip = request.client.host if request.client else "?"
    try:
        return answer_chat(req, ip=ip)
    except UpstreamError as exc:
        return _upstream_error_response(exc)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FormalRewriteRequest(BaseModel):
    summary: str = ""
    chapters: list[dict] = []
    lang: str = ""
    _custom_prompt: str = ""

    class Config:
        extra = "allow"


class TitleColorsRequest(BaseModel):
    title: str


class TestTitleColorsRequest(BaseModel):
    title: str
    prompt: str = ""


@router.post("/title-colors")
@limiter.limit("10/minute")
def title_colors(request: Request, req: TitleColorsRequest):
    """Return video title split into colored segments for brutalist theme."""
    from chat_service import title_colors as _title_colors

    try:
        return _title_colors(req.title)
    except UpstreamError as exc:
        return _upstream_error_response(exc)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/test-title-colors")
@limiter.limit("10/minute")
def test_title_colors(request: Request, req: TestTitleColorsRequest):
    """Test endpoint: title colors with editable prompt."""
    from chat_service import title_colors as _title_colors

    try:
        return _title_colors(req.title, prompt_override=req.prompt or None)
    except UpstreamError as exc:
        return _upstream_error_response(exc)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/formal-rewrite")
@limiter.limit("10/minute")
def formal_rewrite(request: Request, req: FormalRewriteRequest):
    """Rewrite summary and chapters in formal/professional tone."""
    from chat_service import formal_rewrite as _formal_rewrite

    try:
        return _formal_rewrite(req)
    except UpstreamError as exc:
        return _upstream_error_response(exc)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# `/test/full-summary` + `/test/suggested-questions` (and the
# `FullSummaryRequest` model they share with the chapters routes) moved
# to `test_routes.py` in Phase 4a A4 (2026-05-08). The 8 `/translate/*`
# handlers (and their Pydantic models) moved to `translate_routes.py`
# in Bundle 2 of the post-Phase-6 cleanup follow-up (2026-05-09).


@router.get("/summary-tone-test-prompt")
def summary_tone_test_prompt():
    """Return the actual system prompts for the tone test page."""
    from prompts import SYSTEM_PROMPT, CASUAL_SYSTEM_PROMPT
    lang_instruction = "\n\nWrite the ENTIRE summary (all paragraphs, including Context) in English."
    return {
        "system_casual": CASUAL_SYSTEM_PROMPT + lang_instruction,
        "system_formal": SYSTEM_PROMPT + lang_instruction,
        "user_msg": "Below is the transcript of a YouTube video.",
    }


class ToneTestRequest(BaseModel):
    system_prompt: str = ""
    user_msg: str = ""
    casual: bool = True


@router.post("/summary-tone-test")
def summary_tone_test(request: Request, req: ToneTestRequest):
    """Direct LLM call with custom system/user for tone testing."""
    try:
        from openai_client import get_client as _get_client
        client = _get_client()
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": req.system_prompt},
                {"role": "user", "content": req.user_msg},
            ],
            temperature=0.45 if req.casual else 0.3,
            max_tokens=1400,
        )
        raw = response.choices[0].message.content.strip()
        return {"summary": raw}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
