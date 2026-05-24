"""Extraction service — turns capture inputs into extraction outcomes.

The service is the join point for the different capture modes:

  * Text capture: input is already text; delegate straight to the extractor.
  * Voice capture: input is audio; transcribe via the `TranscriberPort`,
    then delegate the resulting text to the same extractor pipeline.
  * Photo capture: input is image bytes; call the `VisionExtractorPort`
    (which internally has already been handed normalized image bytes via
    the preprocessor), then emit deterministic per-field SSE deltas
    wrapping the result — so the on-the-wire vocabulary matches text +
    voice without depending on upstream vision-model token streaming.

Centralising the join here keeps routes thin (per tech plan §12) and
keeps the frontend's wire vocabulary uniform — every capture mode emits
the same `StreamEvent` shape, regardless of how the source bytes
became text.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from typing import Literal

from captureshark.adapters.image_preprocessor import (
    PreprocessOutcome,
    normalize as default_image_normalize,
)
from captureshark.domain.capture import (
    PhotoCaptureInput,
    TextCaptureInput,
    VoiceCaptureInput,
)
from captureshark.domain.extraction import (
    ExtractionError,
    ExtractionErrorKind,
    ExtractionOutcome,
    ExtractorPort,
    PhotoDonePayload,
    PhotoRowPayload,
    StreamEvent,
    StreamWarning,
    photo_row_idempotency_key,
)
from captureshark.domain.signal_gate import passes_signal_gate
from captureshark.domain.transcription import (
    TranscriberPort,
    TranscriptionErrorKind,
)
from captureshark.domain.vision import (
    PhotoExtractionRow,
    VisionExtractorPort,
)

logger = logging.getLogger(__name__)


# Translation table — transcription errors → extraction errors. The
# frontend only knows the extraction-error vocabulary; mapping here keeps
# the route + UI ignorant of which step failed (the user only cares
# whether the AI worked, not which AI).
_TRANSCRIPTION_TO_EXTRACTION: dict[
    TranscriptionErrorKind, ExtractionErrorKind
] = {
    TranscriptionErrorKind.EMPTY_AUDIO: ExtractionErrorKind.EMPTY_INPUT,
    TranscriptionErrorKind.UNSUPPORTED_FORMAT: ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE,
    TranscriptionErrorKind.UPSTREAM_UNAVAILABLE: ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
    TranscriptionErrorKind.UPSTREAM_RATE_LIMITED: ExtractionErrorKind.UPSTREAM_RATE_LIMITED,
    TranscriptionErrorKind.NO_SPEECH: ExtractionErrorKind.EMPTY_INPUT,
    TranscriptionErrorKind.UNEXPECTED: ExtractionErrorKind.UNEXPECTED,
}


class ExtractionService:
    """Use-case service for running an extraction.

    Holds an `ExtractorPort` (required — text extraction is the universal
    fallback), and optional `TranscriberPort` (voice path) and
    `VisionExtractorPort` (photo path) injected at construction time.
    Optional adapters mean test fixtures only need to wire what they
    exercise, and production deployments can disable a capture mode
    by simply not configuring its adapter.

    Capability properties (`supports_voice`, `supports_photo`) let
    route handlers cleanly refuse a streaming request BEFORE opening
    the SSE response, so a misconfigured server returns a clean 503
    JSON error rather than a broken stream that errors mid-flight.
    """

    def __init__(
        self,
        extractor: ExtractorPort,
        transcriber: TranscriberPort | None = None,
        vision_extractor: VisionExtractorPort | None = None,
        image_preprocessor: Callable[[bytes, str], PreprocessOutcome] | None = None,
    ) -> None:
        self._extractor = extractor
        self._transcriber = transcriber
        self._vision_extractor = vision_extractor
        # The preprocessor defaults to the production normalize
        # function so any caller that wires a vision adapter gets
        # mandatory image normalisation automatically. Tests can
        # inject a no-op or fake to keep the service-layer tests
        # focused on routing logic rather than image processing.
        self._image_preprocessor = image_preprocessor or default_image_normalize

    @property
    def supports_voice(self) -> bool:
        """True iff a transcriber adapter is wired (voice capture is live)."""
        return self._transcriber is not None

    @property
    def supports_photo(self) -> bool:
        """True iff a vision extractor adapter is wired (photo capture is live)."""
        return self._vision_extractor is not None

    def extract_text_capture(self, capture: TextCaptureInput) -> ExtractionOutcome:
        """Extract structured fields from a free-form text capture."""
        return self._extractor.extract_from_text(capture.text)

    def stream_text_capture(self, capture: TextCaptureInput) -> Iterator[StreamEvent]:
        """Streaming variant — yields delta events then one terminal event.

        Mirrors `extract_text_capture` shape-wise. The route layer translates
        each yielded event to a Server-Sent Events frame; the frontend
        renders fields progressively.

        Defence-in-depth: the frontend gates obvious garbage before submit,
        but if a broken/scripted client posts straight to this endpoint
        we still want to refuse spending an LLM call on it.
        """
        if not passes_signal_gate(capture.text):
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.NO_SIGNAL,
                    detail="Input had no extractable signal.",
                ),
            )
            return
        yield from self._extractor.stream_from_text(capture.text)

    def stream_voice_capture(
        self, capture: VoiceCaptureInput
    ) -> Iterator[StreamEvent]:
        """Streaming voice path: transcribe, then forward extractor events.

        Whisper doesn't support streaming partial transcripts, so the
        transcribe step is blocking — the SSE stream stays silent until
        Whisper returns. Once we have the transcript, we hand off to
        the same `stream_from_text` machinery the text path uses, so
        the frontend sees an identical event vocabulary.

        A transcription failure is translated into the extraction error
        vocabulary and emitted as a single `("error", ...)` terminal
        event, matching the contract `stream_from_text` callers already
        rely on.
        """
        if self._transcriber is None:
            # No transcriber configured — yield a clean error event
            # rather than raising inside the streaming iterator. Routes
            # SHOULD have guarded this via `supports_voice` before
            # opening the SSE response, but the in-stream check is
            # defence-in-depth: if a misconfigured deployment slipped
            # past the route guard somehow, the client still sees a
            # well-formed SSE error frame instead of a broken stream.
            logger.warning("voice.no_transcriber_configured")
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="Voice capture is not configured on the server.",
                ),
            )
            return

        outcome = self._transcriber.transcribe(capture.audio, capture.content_type)
        if outcome[0] == "error":
            err = outcome[1]
            logger.warning(
                "voice.transcription_failed",
                extra={
                    "transcription_error_kind": err.kind.value,
                    "content_type": capture.content_type,
                    "audio_bytes": len(capture.audio),
                },
            )
            yield (
                "error",
                ExtractionError(
                    kind=_TRANSCRIPTION_TO_EXTRACTION[err.kind],
                    detail=err.detail,
                ),
            )
            return

        transcript = outcome[1].text
        logger.info(
            "voice.transcribed",
            extra={
                "audio_bytes": len(capture.audio),
                "content_type": capture.content_type,
                "transcript_chars": len(transcript),
            },
        )
        # Post-Whisper gate: catches transcripts that came back empty,
        # too short, or matching a known Whisper-on-silence hallucination
        # ("Thank you for watching", "Bye", "you"). The user spoke real
        # time but produced no extractable signal — bounce back to
        # voice phase rather than serving an empty review card.
        if not passes_signal_gate(transcript):
            logger.info(
                "voice.no_signal",
                extra={"transcript_chars": len(transcript)},
            )
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.NO_SIGNAL,
                    detail="Transcript had no extractable signal.",
                ),
            )
            return
        yield from self._extractor.stream_from_text(transcript)

    def stream_photo_capture(
        self, capture: PhotoCaptureInput
    ) -> Iterator[StreamEvent]:
        """Streaming photo path — emits the photo-namespaced SSE
        vocabulary (`photo_warning` + `photo_row`* + terminal
        `photo_done`).

        Flow:
          1. Defence-in-depth guard: if no vision adapter is wired,
             yield a clean `error` event. Routes should have guarded
             this via `supports_photo` first.
          2. Preprocess the image.
          3. Call the vision adapter (non-streaming).
          4. Forward any photo-level warnings as non-terminal
             `photo_warning` events.
          5. Filter rows through the per-row signal gate (drops the
             all-empty / all-noise rows the model occasionally
             produces). Surviving rows are re-indexed densely
             (0..N-1) and emitted as `photo_row` events in document
             reading order.
          6. Emit terminal `photo_done` with status:
               * `"ok"`        — all adapter rows passed the gate.
               * `"partial"`   — some rows survived, some dropped.
                                 Carries a `dropped_signal_gate:<n>`
                                 warning code.
               * `"no_signal"` — zero rows survived. Slice B's
                                 retake overlay surfaces from this
                                 status (NOT from an `error` event —
                                 `error` is reserved for hard
                                 upstream failures).

        See `docs/_spec/photo_capture.md` for the
        locked wire contract (status enum, total_rows semantics,
        per-row idempotency key format).
        """
        if self._vision_extractor is None:
            logger.warning("photo.no_vision_extractor_configured")
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="Photo capture is not configured on the server.",
                ),
            )
            return

        # Mandatory normalisation BEFORE the vision adapter sees the
        # bytes (EXIF orientation, HEIC decode, JPEG conversion,
        # metadata strip, dimension cap). Preprocessor errors flow
        # through as SSE error events with the appropriate image-
        # specific error kind (IMAGE_TOO_LARGE / UNSUPPORTED_IMAGE /
        # IMAGE_DECODE_FAILED / IMAGE_TOO_SMALL / IMAGE_PREPROCESS_FAILED).
        preprocess = self._image_preprocessor(capture.image, capture.content_type)
        if preprocess[0] == "error":
            err = preprocess[1]
            logger.info(
                "photo.preprocess_failed",
                extra={
                    "preprocess_error_kind": err.kind.value,
                    "content_type": capture.content_type,
                    "image_bytes": len(capture.image),
                },
            )
            yield ("error", err)
            return

        clean = preprocess[1]
        outcome = self._vision_extractor.extract_from_image(
            clean.bytes, clean.content_type
        )
        if outcome[0] == "error":
            err = outcome[1]
            logger.warning(
                "photo.extraction_failed",
                extra={
                    "extraction_error_kind": err.kind.value,
                    "content_type": capture.content_type,
                    "image_bytes": len(capture.image),
                },
            )
            yield ("error", err)
            return

        result = outcome[1]
        logger.info(
            "photo.extracted",
            extra={
                "image_bytes": len(capture.image),
                "content_type": capture.content_type,
                "row_count": len(result.rows),
            },
        )

        # Photo-level warnings ride as non-terminal `photo_warning`
        # events. These are advisories the model surfaced about the
        # whole image (e.g. "image was crooked, results may be
        # partial"), distinct from per-row warnings (which travel
        # with the row in `photo_row.warnings`).
        for warning_text in result.warnings:
            yield (
                "photo_warning",
                StreamWarning(
                    code="photo_advisory", message=warning_text
                ),
            )

        # Per-row signal gate — defence-in-depth against rows the
        # model surfaced that are all empty / pure noise. Indices
        # are re-densified (0..N-1) on the surviving rows so the
        # wire contract's "no gaps in row_index" guarantee holds
        # regardless of which originals dropped.
        surviving: list[PhotoExtractionRow] = [
            row for row in result.rows if _row_passes_signal_gate(row)
        ]
        dropped_count = len(result.rows) - len(surviving)
        batch_warnings: list[str] = []
        if dropped_count > 0:
            logger.info(
                "photo.rows_dropped_signal_gate",
                extra={
                    "dropped_count": dropped_count,
                    "kept_count": len(surviving),
                },
            )
            batch_warnings.append(f"dropped_signal_gate:{dropped_count}")

        provider = self._vision_extractor.provider_name

        for new_index, row in enumerate(surviving):
            key = photo_row_idempotency_key(
                capture.capture_id, new_index, row.fields
            )
            yield (
                "photo_row",
                PhotoRowPayload(
                    row_index=new_index,
                    idempotency_key=key,
                    fields=row.fields,
                    row_confidence=row.confidence,
                    warnings=row.warnings,
                ),
            )

        if not surviving:
            status: Literal["ok", "partial", "no_signal"] = "no_signal"
            logger.info(
                "photo.no_signal",
                extra={"image_bytes": len(capture.image)},
            )
        elif dropped_count > 0:
            status = "partial"
        else:
            status = "ok"

        yield (
            "photo_done",
            PhotoDonePayload(
                status=status,
                total_rows=len(surviving),
                provider=provider,
                warnings=tuple(batch_warnings),
            ),
        )


def _row_passes_signal_gate(row: PhotoExtractionRow) -> bool:
    """Defence-in-depth signal gate for a photo-extracted row.

    Mirrors the post-Whisper gate on the voice path. Accumulates the
    row's source text + every non-empty field value into one string
    and runs the shared `passes_signal_gate` heuristic on it. A row
    whose fields are all empty (or whose only non-empty content is
    "um"-like garbage) fails the gate and the photo extraction
    surfaces as `NO_SIGNAL` instead of an empty review card.
    """
    parts: list[str] = []
    if row.source_text:
        parts.append(row.source_text)
    for f in (
        row.fields.name,
        row.fields.phone,
        row.fields.email,
        row.fields.has_agent,
        row.fields.intent,
        row.fields.timeline,
        row.fields.financing_status,
        row.fields.budget,
        row.fields.area,
        row.fields.follow_up,
        row.fields.notes,
    ):
        if f.value:
            parts.append(f.value)
    combined = " ".join(parts).strip()
    return passes_signal_gate(combined)
