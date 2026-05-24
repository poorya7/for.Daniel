"""
RecapShark — Summary / Chapters / Chat-suggestions route module
================================================================

Owns the 6 endpoints the frontend hits *after* it has subs/transcript in
hand to generate the short summary + chapters, the full summary, the
follow-up chat suggestions, and the alt chapter strategies (v1-even / v2
/ v3). All production-critical — the live frontend pipeline calls every
one of these.

History: this file split out of `routes.py` in Phase 4a A4 (2026-05-08)
for SRP. The 6 routes used to live under a misleading `/test/*` URL
prefix (a holdover from when the SubsProvider pipeline was being built
behind a feature gate); Phase 4a A8 (2026-05-08) renamed the URLs to the
honest grouped scheme below. The file name `test_routes.py` is now
itself a small lie that we'll fix in a follow-up rename — kept as-is for
this pass to keep the diff scoped to URLs (renaming the file forces an
import update in `routes.py` and any tooling that references the file
path; not blocking, just deferred).

Current paths (post-rename):
  POST /summary/short-with-chapters     ← was /test/short-summary-chapters
  POST /summary/full                    ← was /test/full-summary
  POST /chapters/v1-even                ← was /test/chapters-v1-even
  POST /chapters/v2                     ← was /test/chapters-v2
  POST /chapters/v3                     ← was /test/chapters-v3
  POST /chat/suggested-questions        ← was /test/suggested-questions

Mounted unconditionally in prod via `routes.py` →
`router.include_router(test_router)`. No env gate.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from deps import limiter
from get_audio import extract_video_id
from constants import SAMPLED_TEXT_MAX_CHARS, CHAPTERS_TRANSCRIPT_MAX_CHARS
from youtube_routes import fetch_youtube_meta

test_router = APIRouter()


class ShortSummaryRequest(BaseModel):
    transcript_text: str
    lang: str = "en"
    segments: list[dict]
    video_duration: float
    video_meta: dict | None = None


class FullSummaryRequest(BaseModel):
    transcript_text: str
    lang: str = "en"  # language of the transcript; summary is generated in this language
    video_meta: dict | None = None
    url: str | None = None  # if provided, fetch metadata for full summary context


class ChaptersV2Request(BaseModel):
    transcript_text: str
    segments: list[dict]
    lang: str = "en"
    video_duration: float


@test_router.post("/summary/short-with-chapters")
@limiter.limit("30/minute")
def short_summary_chapters(request: Request, req: ShortSummaryRequest):
    """Generate short summary + chapters from transcript (for SubsProvider test flow)."""

    try:
        from openai_client import get_client as _get_client
        from worker import _build_sampled_text, _fast_call_summary, _fast_call_chapters
        import concurrent.futures

        snippets = [{"text": s.get("text", ""), "start": s.get("start", 0), "duration": s.get("duration", 0)} for s in req.segments]
        sampled_text = _build_sampled_text(snippets, req.transcript_text, req.video_duration) if snippets else req.transcript_text[:SAMPLED_TEXT_MAX_CHARS]
        client = _get_client()

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            fut_summary = executor.submit(_fast_call_summary, client, sampled_text, req.lang, req.video_duration)
            fut_chapters = executor.submit(_fast_call_chapters, client, sampled_text, req.lang, req.video_duration)
            return {"short_summary": fut_summary.result(), "chapters": fut_chapters.result()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@test_router.post("/chapters/v2")
@limiter.limit("30/minute")
def chapters_v2(request: Request, req: ChaptersV2Request):
    """Generate chapters from full transcript (no sampling)."""

    try:
        from openai_client import get_client as _get_client
        from worker import _call_chapters_v2

        from worker import _fmt_hms
        segs = req.segments
        lines = [f"[{_fmt_hms(s.get('start', 0))}] {s.get('text', '')}" for s in segs]
        timestamped = "\n".join(lines)
        if len(timestamped) > CHAPTERS_TRANSCRIPT_MAX_CHARS:
            step = max(2, len(segs) // (CHAPTERS_TRANSCRIPT_MAX_CHARS // 50))
            lines = [f"[{_fmt_hms(s.get('start', 0))}] {s.get('text', '')}" for s in segs[::step]]
            timestamped = "\n".join(lines)
            if len(timestamped) > CHAPTERS_TRANSCRIPT_MAX_CHARS:
                timestamped = timestamped[:CHAPTERS_TRANSCRIPT_MAX_CHARS]

        client = _get_client()
        chapters = _call_chapters_v2(client, timestamped, req.lang, req.video_duration)
        return {"chapters": chapters}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@test_router.post("/chapters/v3")
@limiter.limit("30/minute")
def chapters_v3(request: Request, req: ChaptersV2Request):
    """Map-reduce chapters: per-window topic extraction then merge."""

    try:
        from openai_client import get_client as _get_client
        from worker import _map_reduce_chapters

        snippets = [{"text": s.get("text", ""), "start": s.get("start", 0), "duration": s.get("duration", 0)} for s in req.segments]
        client = _get_client()
        chapters = _map_reduce_chapters(client, snippets, req.lang, req.video_duration)
        return {"chapters": chapters}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@test_router.post("/chapters/v1-even")
@limiter.limit("30/minute")
def chapters_v1_even(request: Request, req: ChaptersV2Request):
    """Fast chapters using evenly sub-sampled segments (Option A)."""

    try:
        from openai_client import get_client as _get_client
        from worker import _build_even_sampled_text, _call_chapters_v2

        snippets = [{"text": s.get("text", ""), "start": s.get("start", 0), "duration": s.get("duration", 0)} for s in req.segments]
        sampled = _build_even_sampled_text(snippets, req.video_duration)
        client = _get_client()
        chapters = _call_chapters_v2(client, sampled, req.lang, req.video_duration)
        return {"chapters": chapters}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@test_router.post("/summary/full")
@limiter.limit("30/minute")
def full_summary(request: Request, req: FullSummaryRequest):
    """Generate full summary from transcript (post-pipeline, after subs land).

    Returns the summary as soon as it's ready. Suggested chat questions
    are fetched separately via /api/chat/suggested-questions so they
    never block summary delivery (they were previously bundled here and
    added 2-5s of wait time when the questions call ran longer than the
    summary call).
    """

    try:
        from summarize import summarize

        video_meta = req.video_meta
        if not video_meta and req.url:
            try:
                video_id = extract_video_id(req.url)
                yt_meta = fetch_youtube_meta(video_id)
                video_meta = {
                    "title": yt_meta.get("title"),
                    "channel": yt_meta.get("channel_title"),
                    "description": (yt_meta.get("description") or "")[:3000],
                }
            except Exception:
                pass

        summary = summarize(req.transcript_text, is_partial=False,
                            video_meta=video_meta, lang=req.lang, casual=True)
        return {"summary": summary}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@test_router.post("/chat/suggested-questions")
@limiter.limit("30/minute")
def suggested_questions(request: Request, req: FullSummaryRequest):
    """Generate ~10 video-specific suggested chat questions.

    Called by the frontend in parallel with /api/summary/full so it
    never gates the summary render. Best-effort: returns an empty array
    on failure and the chat UI falls back to its static chip pair.
    """
    try:
        from summarize import suggest_questions

        video_meta = req.video_meta
        if not video_meta and req.url:
            try:
                video_id = extract_video_id(req.url)
                yt_meta = fetch_youtube_meta(video_id)
                video_meta = {
                    "title": yt_meta.get("title"),
                    "channel": yt_meta.get("channel_title"),
                    "description": (yt_meta.get("description") or "")[:3000],
                }
            except Exception:
                pass

        questions = suggest_questions(req.transcript_text, lang=req.lang,
                                      video_meta=video_meta)
        return {"questions": questions}
    except Exception as e:
        print(f"[WARN] suggested-questions endpoint failed: {e}", flush=True)
        return {"questions": []}
