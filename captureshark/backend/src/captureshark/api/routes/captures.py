"""Captures router — submit input, get extracted fields back.

For step 2 (text capture local-only) this is a single endpoint. Voice and
photo will land as additional source-discriminated branches on the same
`POST /captures` route, or as sibling routes if the input shape diverges
sharply (e.g., multipart for photo).

Note: v1 does not yet persist captures server-side (per tech plan §8: no raw
captures stored). The endpoint is effectively stateless extraction. Persistence
arrives with the Sheets-write step; until then `capture_id` is not returned
because there is nothing to look up.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile, status
from fastapi.responses import JSONResponse, StreamingResponse

from captureshark.api.deps import get_extraction_service
from captureshark.api.sse_heartbeat import with_heartbeat
from captureshark.api.schemas import (
    ErrorBody,
    ErrorResponse,
    ExtractionResultDTO,
    TextCaptureRequest,
    fields_to_dto,
    result_to_dto,
)
from captureshark.domain.capture import (
    PhotoCaptureInput,
    TextCaptureInput,
    VoiceCaptureInput,
)
from captureshark.domain.extraction import ExtractionError, ExtractionErrorKind, StreamEvent
from captureshark.services.extraction_service import ExtractionService

# Mirrors the OpenAI Whisper / file-API limit (25 MB) — anything larger
# than this is a sign of a sustained recording (a worried bot leaving
# a 90-minute stream open) rather than a real broker note. Reject early
# so the upstream call doesn't waste a round trip.
_MAX_AUDIO_BYTES = 25 * 1024 * 1024

# Photo upload cap. Modern phone JPEGs are 2-5 MB; HEIC originals can
# push 8 MB. 10 MB gives comfortable headroom for the rare oversized
# capture while rejecting obvious abuse (compressed video, scanned
# multi-page PDFs masquerading as images). The preprocessor enforces
# stricter dimension + megapixel caps after decode — this byte cap is
# the cheap pre-decode gate.
_MAX_IMAGE_BYTES = 10 * 1024 * 1024

router = APIRouter(tags=["captures"])


# Maps domain error kinds → (HTTP status, error code, plain-English copy).
# Per tech plan §6: API translates domain errors-as-data to HTTP. Per the v1
# sketch §10 ("fail clean"): copy is plain-English, no jargon, never raw codes.
_ERROR_TABLE: dict[ExtractionErrorKind, tuple[int, str, str]] = {
    ExtractionErrorKind.EMPTY_INPUT: (
        status.HTTP_400_BAD_REQUEST,
        "empty_input",
        "Couldn't read your note — it looked empty.",
    ),
    ExtractionErrorKind.NO_SIGNAL: (
        status.HTTP_400_BAD_REQUEST,
        "no_signal",
        "Didn't catch that — try once more.",
    ),
    ExtractionErrorKind.UPSTREAM_UNAVAILABLE: (
        status.HTTP_502_BAD_GATEWAY,
        "ai_unavailable",
        "Our AI is taking a moment, hang on — try again in a sec.",
    ),
    ExtractionErrorKind.UPSTREAM_RATE_LIMITED: (
        status.HTTP_429_TOO_MANY_REQUESTS,
        "ai_busy",
        "We're at capacity right now — try again in a minute. Your note is safe.",
    ),
    ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE: (
        status.HTTP_502_BAD_GATEWAY,
        "ai_garbled",
        "The AI sent back something we couldn't read — try again?",
    ),
    ExtractionErrorKind.UNEXPECTED: (
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "extraction_failed",
        "Something went wrong on our end. Try again in a moment.",
    ),
    # Photo-path error kinds. Status codes match the failure semantics:
    # 413 for upload-too-large (matches voice's audio_too_large), 400
    # for bad/unsupported input, 500 for unexpected preprocess crashes,
    # 400 for moderation refusal (the client can retry with a different
    # photo — not a server fault).
    ExtractionErrorKind.IMAGE_TOO_LARGE: (
        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        "image_too_large",
        "That photo is too large. Try taking a new one.",
    ),
    ExtractionErrorKind.UNSUPPORTED_IMAGE: (
        status.HTTP_400_BAD_REQUEST,
        "unsupported_image",
        "That photo format didn't work. Try a different photo.",
    ),
    ExtractionErrorKind.IMAGE_DECODE_FAILED: (
        status.HTTP_400_BAD_REQUEST,
        "unsupported_image",
        "Couldn't open that photo. Try another one.",
    ),
    ExtractionErrorKind.IMAGE_TOO_SMALL: (
        status.HTTP_400_BAD_REQUEST,
        "image_too_small",
        "That photo's too small to read. Try a bigger one.",
    ),
    ExtractionErrorKind.IMAGE_PREPROCESS_FAILED: (
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "extraction_failed",
        "Something went wrong on our end. Try again in a moment.",
    ),
    ExtractionErrorKind.IMAGE_MODERATION_REFUSED: (
        status.HTTP_400_BAD_REQUEST,
        "image_moderation",
        "Couldn't process that photo — try again?",
    ),
}


@router.post(
    "/captures",
    response_model=ExtractionResultDTO,
    summary="Submit a capture and receive extracted fields",
    responses={
        400: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
def create_capture(
    payload: TextCaptureRequest,
    service: Annotated[ExtractionService, Depends(get_extraction_service)],
) -> ExtractionResultDTO | JSONResponse:
    """Run extraction on the submitted text and return structured fields."""
    outcome = service.extract_text_capture(TextCaptureInput(text=payload.text))
    if outcome[0] == "ok":
        return result_to_dto(outcome[1])
    return _error_response(outcome[1])


def _error_response(err: ExtractionError) -> JSONResponse:
    http_status, code, message = _ERROR_TABLE[err.kind]
    body = ErrorResponse(error=ErrorBody(code=code, message=message))
    return JSONResponse(status_code=http_status, content=body.model_dump())


@router.post(
    "/captures/stream",
    summary="Stream extraction deltas as Server-Sent Events",
    responses={
        400: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
def stream_capture(
    payload: TextCaptureRequest,
    service: Annotated[ExtractionService, Depends(get_extraction_service)],
) -> StreamingResponse:
    """Stream extraction events as the AI generates them.

    Wire format = SSE (`text/event-stream`). Each event has an explicit
    `event:` line so the frontend can route by type without parsing the
    JSON payload first:

      event: delta\\ndata: {"content":"..."}\\n\\n
      event: done\\ndata: {"fields":{...},"original_text":"..."}\\n\\n
      event: error\\ndata: {"code":"...","message":"..."}\\n\\n

    Total time on the wire is the same as the non-streaming endpoint, but
    the frontend can render fields the moment each one completes, so the
    perceived wait drops dramatically (per v1 sketch §10).
    """
    return StreamingResponse(
        _sse_event_stream(service, payload),
        media_type="text/event-stream",
        headers={
            # Disable proxy buffering so events flush as they're produced.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _sse_event_stream(service: ExtractionService, payload: TextCaptureRequest) -> Iterator[bytes]:
    """Translate domain `StreamEvent`s to SSE-formatted byte frames."""
    for event in service.stream_text_capture(TextCaptureInput(text=payload.text)):
        yield _format_sse(event)


@router.post(
    "/captures/voice",
    summary="Stream voice extraction deltas as Server-Sent Events",
    # `response_model=None` because the success response is a streaming
    # SSE body and the error responses are JSON — FastAPI can't build
    # one Pydantic model that covers both shapes, and shouldn't try.
    response_model=None,
    responses={
        400: {"model": ErrorResponse},
        413: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def stream_voice_capture(
    service: Annotated[ExtractionService, Depends(get_extraction_service)],
    audio: Annotated[UploadFile, File(description="Recorded audio blob")],
    content_type: Annotated[
        str | None,
        Form(description="Override audio MIME type if the upload's is missing/wrong"),
    ] = None,
) -> StreamingResponse | JSONResponse:
    """Transcribe an audio blob and stream extraction events.

    Wire format mirrors `/captures/stream` — once Whisper returns the
    transcript, the same `delta` / `done` / `error` SSE events flow
    out, so the frontend's existing handler just works. Until Whisper
    finishes (typically 3-15s for a sub-30s recording), the stream
    stays silent; the client should keep its "extracting…" UI on screen.

    `audio` is a multipart `UploadFile`; `content_type` is an optional
    form-field override for browsers that don't tag the blob with the
    right MIME (Safari historically labels everything `application/octet-stream`).
    """
    # Capability guard: refuse cleanly with 503 JSON if voice isn't
    # configured, BEFORE opening the SSE response. A capability check
    # inside the streaming iterator would leave the client looking at
    # a broken stream (status 200 + headers sent + error mid-flight).
    if not service.supports_voice:
        return _service_unavailable_response("Voice capture is not configured on the server.")

    blob = await audio.read()
    if not blob:
        return _error_response(
            ExtractionError(
                kind=ExtractionErrorKind.EMPTY_INPUT,
                detail="No audio was supplied.",
            )
        )
    if len(blob) > _MAX_AUDIO_BYTES:
        body = ErrorResponse(
            error=ErrorBody(
                code="audio_too_large",
                message="That recording is too long — try keeping it under a minute.",
            )
        )
        return JSONResponse(status_code=413, content=body.model_dump())

    resolved_type = content_type or audio.content_type or "application/octet-stream"
    capture = VoiceCaptureInput(audio=blob, content_type=resolved_type)

    return StreamingResponse(
        _voice_event_stream(service, capture),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _voice_event_stream(
    service: ExtractionService, capture: VoiceCaptureInput
) -> Iterator[bytes]:
    for event in service.stream_voice_capture(capture):
        yield _format_sse(event)


@router.post(
    "/captures/photo",
    summary="Stream photo extraction deltas as Server-Sent Events",
    # Same response-model story as `/captures/voice`: success is SSE,
    # errors are JSON; FastAPI can't unify the two as one Pydantic model.
    response_model=None,
    responses={
        400: {"model": ErrorResponse},
        413: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def stream_photo_capture(
    service: Annotated[ExtractionService, Depends(get_extraction_service)],
    image: Annotated[UploadFile, File(description="Captured photo blob")],
    content_type: Annotated[
        str | None,
        Form(description="Override image MIME type if the upload's is missing/wrong"),
    ] = None,
) -> StreamingResponse | JSONResponse:
    """Extract lead rows from a photo and stream events.

    Step 8 contract (Slice C): emits the photo-namespaced SSE
    vocabulary — `photo_warning` (non-terminal advisory) →
    `photo_row` (one per extracted row, document reading order, with
    server-generated idempotency keys) → terminal `photo_done`
    (status + total_rows + provider + batch warnings) or `error`
    (hard upstream failure). Distinct from the text/voice wire which
    keeps `delta`/`done`/`error`. See
    `docs/_spec/photo_capture.md` for the locked
    contract.

    Zero rows extracted is NOT an error — it surfaces as
    `photo_done { status: "no_signal" }`. The frontend's failure
    overlay branches on that status. `error` is reserved for
    network / upstream / auth failures.

    `image` is a multipart `UploadFile`; `content_type` is an
    optional form-field override for clients that mislabel the MIME
    (mobile browsers sometimes default to `application/octet-stream`
    on canvas-derived blobs).
    """
    if not service.supports_photo:
        return _service_unavailable_response("Photo capture is not configured on the server.")

    blob = await image.read()
    if not blob:
        return _error_response(
            ExtractionError(
                kind=ExtractionErrorKind.EMPTY_INPUT,
                detail="No image was supplied.",
            )
        )
    if len(blob) > _MAX_IMAGE_BYTES:
        return _error_response(
            ExtractionError(
                kind=ExtractionErrorKind.IMAGE_TOO_LARGE,
                detail="Image exceeded the upload size limit.",
            )
        )

    resolved_type = content_type or image.content_type or "application/octet-stream"
    # Mint a short opaque capture_id for this request. Seeds the
    # per-row idempotency keys the service stamps onto every
    # `photo_row` event so the offline-queue drainer can dedupe row-
    # level saves across retries. 12 hex chars = 48 bits — plenty of
    # entropy at our request rate, short enough to embed cleanly.
    capture = PhotoCaptureInput(
        image=blob,
        content_type=resolved_type,
        capture_id=uuid.uuid4().hex[:12],
    )

    # The photo extraction is dominated by a single ~3-5 second
    # blocking call to the upstream vision model. Without server-
    # sent heartbeats during that window, the client has no way to
    # tell "AI is just thinking" from "TCP dropped" — and its
    # watchdog ends up showing the user a false "No internet"
    # message on every slow extraction. `with_heartbeat` interleaves
    # tiny `event: heartbeat` SSE frames every 2 seconds while the
    # inner sync generator is idle, so the client can reset its
    # watchdog on each one and only fire a real "no internet" if
    # heartbeats actually stop. The wrapper runs the sync generator
    # in a worker thread (asyncio.to_thread) and merges its bytes
    # back into an async stream — the inner function stays sync
    # and unchanged.
    return StreamingResponse(
        with_heartbeat(lambda: _photo_event_stream(service, capture)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _photo_event_stream(
    service: ExtractionService, capture: PhotoCaptureInput
) -> Iterator[bytes]:
    for event in service.stream_photo_capture(capture):
        yield _format_sse(event)


def _service_unavailable_response(message: str) -> JSONResponse:
    """Build the 503 JSON body the capability guards return.

    Plain-English copy + a stable machine code so the frontend can
    branch (e.g. surface the gallery-upload-only mode when camera /
    photo is unsupported, or show "voice capture not available" copy
    when voice is unsupported).
    """
    body = ErrorResponse(
        error=ErrorBody(code="capture_not_configured", message=message)
    )
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=body.model_dump())


def _format_sse(event: StreamEvent) -> bytes:
    """Translate one domain stream event to an SSE frame.

    Uses a `match` so mypy can narrow each arm — addressing the same
    discriminated-tuple shape we use for the non-streaming `ExtractionOutcome`.

    Two vocabularies share the wire:
      * Text + voice: `delta` (non-terminal) → `done` / `error`
        (terminal).
      * Photo: `photo_warning` (non-terminal) → `photo_row`*
        (non-terminal, one per extracted row) → `photo_done` /
        `error` (terminal). See
        `docs/_spec/photo_capture.md` for the locked
        contract.

    The service layer is responsible for emitting a valid sequence —
    this function just translates each event to its wire frame.
    """
    match event:
        case ("delta", delta):
            return _sse_frame("delta", {"content": delta.content})
        case ("done", result):
            return _sse_frame(
                "done",
                {
                    "fields": fields_to_dto(result.fields).model_dump(),
                    "original_text": result.original_text,
                },
            )
        case ("error", err):
            _, code, message = _ERROR_TABLE[err.kind]
            return _sse_frame("error", {"code": code, "message": message})
        case ("photo_warning", warning):
            return _sse_frame(
                "photo_warning",
                {"code": warning.code, "message": warning.message},
            )
        case ("photo_row", row):
            return _sse_frame(
                "photo_row",
                {
                    "row_index": row.row_index,
                    "idempotency_key": row.idempotency_key,
                    "fields": fields_to_dto(row.fields).model_dump(),
                    "row_confidence": row.row_confidence.value,
                    "warnings": list(row.warnings),
                },
            )
        case ("photo_done", done):
            return _sse_frame(
                "photo_done",
                {
                    "status": done.status,
                    "total_rows": done.total_rows,
                    "provider": done.provider,
                    "warnings": list(done.warnings),
                },
            )


def _sse_frame(event_name: str, data: dict[str, object]) -> bytes:
    """Build one SSE frame: an `event:` line, a `data:` line, and the
    blank-line terminator that flushes the frame to the client."""
    return f"event: {event_name}\ndata: {json.dumps(data)}\n\n".encode()
