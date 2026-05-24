"""Service-layer tests for `ExtractionService`.

These confirm the service correctly delegates to its injected `ExtractorPort`
and forwards both success and error outcomes unchanged. Real upstream call
behaviour is exercised by the adapter tests, not here.
"""

from __future__ import annotations

import pytest
from collections.abc import Callable, Iterator

from captureshark.domain.capture import (
    PhotoCaptureInput,
    TextCaptureInput,
    VoiceCaptureInput,
)
from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionError,
    ExtractionErrorKind,
    ExtractionOutcome,
    ExtractionResult,
    PhotoDonePayload,
    PhotoRowPayload,
    StreamDelta,
    StreamEvent,
    StreamWarning,
)
from captureshark.domain.transcription import (
    TranscriptionError,
    TranscriptionErrorKind,
    TranscriptionOutcome,
    TranscriptionResult,
)
from captureshark.adapters.image_preprocessor import (
    PreprocessOutcome,
    PreprocessedImage,
)
from captureshark.domain.vision import (
    PhotoExtractionOutcome,
    PhotoExtractionResult,
    PhotoExtractionRow,
)
from captureshark.services.extraction_service import ExtractionService


def _passthrough_preprocessor(image: bytes, content_type: str) -> PreprocessOutcome:
    """Test stub: pretends the preprocessor cleaned the bytes.

    Keeps service-layer tests focused on routing logic — the real
    preprocessor has its own dedicated test file. Always returns
    `image/jpeg` to match the production contract that the
    preprocessor normalises everything to JPEG.
    """
    return (
        "ok",
        PreprocessedImage(
            bytes=image,
            content_type="image/jpeg",
            width=800,
            height=600,
        ),
    )


def _failing_preprocessor(kind: ExtractionErrorKind) -> Callable[[bytes, str], PreprocessOutcome]:
    """Test stub factory: pretends the preprocessor rejected the bytes
    with the given error kind. Used to confirm preprocessor errors
    surface as SSE error events with the right code."""

    def _stub(image: bytes, content_type: str) -> PreprocessOutcome:
        return ("error", ExtractionError(kind=kind, detail=f"forced {kind.value}"))

    return _stub


class _FakeTranscriber:
    """Test double for `TranscriberPort`."""

    def __init__(self, behaviour: Callable[[bytes, str], TranscriptionOutcome]) -> None:
        self._behaviour = behaviour
        self.calls: list[tuple[bytes, str]] = []

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptionOutcome:
        self.calls.append((audio, content_type))
        return self._behaviour(audio, content_type)


class _FakeExtractor:
    """Test double that returns whatever the test sets up.

    Implements `ExtractorPort` structurally — no inheritance needed because
    `ExtractorPort` is a `Protocol`.
    """

    def __init__(
        self,
        behaviour: Callable[[str], ExtractionOutcome],
        stream_events: list[StreamEvent] | None = None,
    ) -> None:
        self._behaviour = behaviour
        self._stream_events = stream_events or []
        self.calls: list[str] = []
        self.stream_calls: list[str] = []

    def extract_from_text(self, text: str) -> ExtractionOutcome:
        self.calls.append(text)
        return self._behaviour(text)

    def stream_from_text(self, text: str) -> Iterator[StreamEvent]:
        self.stream_calls.append(text)
        yield from self._stream_events


def _all_fields_high(value: str = "Jane Doe") -> ExtractedFields:
    f = ExtractedField(value=value, confidence=Confidence.HIGH)
    none_field = ExtractedField(value=None, confidence=Confidence.HIGH)
    return ExtractedFields(
        name=f,
        phone=none_field,
        email=none_field,
        has_agent=none_field,
        intent=none_field,
        timeline=none_field,
        financing_status=none_field,
        area=none_field,
        budget=none_field,
        follow_up=none_field,
        notes=none_field,
    )


def test_service_returns_success_outcome_unchanged() -> None:
    success = ExtractionResult(fields=_all_fields_high(), original_text="Jane")
    extractor = _FakeExtractor(lambda _: ("ok", success))
    service = ExtractionService(extractor=extractor)

    outcome = service.extract_text_capture(TextCaptureInput(text="Jane"))

    assert outcome == ("ok", success)
    assert extractor.calls == ["Jane"]


def test_service_returns_error_outcome_unchanged() -> None:
    err = ExtractionError(
        kind=ExtractionErrorKind.UPSTREAM_RATE_LIMITED,
        detail="busy",
    )
    extractor = _FakeExtractor(lambda _: ("error", err))
    service = ExtractionService(extractor=extractor)

    outcome = service.extract_text_capture(TextCaptureInput(text="hello"))

    assert outcome == ("error", err)


def test_service_streams_events_unchanged() -> None:
    success = ExtractionResult(fields=_all_fields_high(), original_text="Jane")
    events: list[StreamEvent] = [
        ("delta", StreamDelta(content='{"na')),
        ("delta", StreamDelta(content='me":')),
        ("done", success),
    ]
    extractor = _FakeExtractor(lambda _: ("ok", success), stream_events=events)
    service = ExtractionService(extractor=extractor)

    received = list(service.stream_text_capture(TextCaptureInput(text="Jane")))

    assert received == events
    assert extractor.stream_calls == ["Jane"]


def test_voice_path_transcribes_then_streams_extractor_events() -> None:
    """Happy path: transcript drives the extractor stream."""
    success = ExtractionResult(fields=_all_fields_high(), original_text="Maria")
    events: list[StreamEvent] = [
        ("delta", StreamDelta(content='{"name":"Maria"}')),
        ("done", success),
    ]
    extractor = _FakeExtractor(lambda _: ("ok", success), stream_events=events)
    transcriber = _FakeTranscriber(
        lambda _audio, _ct: ("ok", TranscriptionResult(text="Maria Lopez 555-0192"))
    )
    service = ExtractionService(extractor=extractor, transcriber=transcriber)

    received = list(
        service.stream_voice_capture(
            VoiceCaptureInput(audio=b"\x00fake-audio", content_type="audio/webm")
        )
    )

    assert received == events
    # Transcriber saw the raw audio + content type.
    assert transcriber.calls == [(b"\x00fake-audio", "audio/webm")]
    # Extractor was driven by the transcript, not the raw audio.
    assert extractor.stream_calls == ["Maria Lopez 555-0192"]


def test_voice_path_translates_transcription_error_to_extraction_error() -> None:
    """A transcription failure surfaces as a single `('error', ExtractionError)`."""
    extractor = _FakeExtractor(
        lambda _: ("error", ExtractionError(ExtractionErrorKind.UNEXPECTED, "x"))
    )
    transcriber = _FakeTranscriber(
        lambda _a, _c: (
            "error",
            TranscriptionError(
                kind=TranscriptionErrorKind.UPSTREAM_RATE_LIMITED,
                detail="busy",
            ),
        )
    )
    service = ExtractionService(extractor=extractor, transcriber=transcriber)

    received = list(
        service.stream_voice_capture(
            VoiceCaptureInput(audio=b"\x00", content_type="audio/webm")
        )
    )

    # Exactly one terminal error event; extractor was never called.
    assert len(received) == 1
    kind, payload = received[0]
    assert kind == "error"
    assert payload.kind == ExtractionErrorKind.UPSTREAM_RATE_LIMITED
    assert extractor.stream_calls == []


def test_voice_path_without_transcriber_yields_clean_error_event() -> None:
    """When no transcriber is wired, the service yields a clean error
    event rather than raising mid-stream. This keeps the SSE contract
    well-formed in the rare case a misconfigured deployment slips
    past the route-layer `supports_voice` capability guard — the
    client sees a normal SSE error frame instead of a broken stream.
    """
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    service = ExtractionService(extractor=extractor)  # no transcriber

    received = list(
        service.stream_voice_capture(
            VoiceCaptureInput(audio=b"\x00", content_type="audio/webm")
        )
    )

    assert len(received) == 1
    kind, payload = received[0]
    assert kind == "error"
    assert isinstance(payload, ExtractionError)
    assert payload.kind == ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def test_supports_voice_false_without_transcriber() -> None:
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    service = ExtractionService(extractor=extractor)
    assert service.supports_voice is False


def test_supports_voice_true_with_transcriber() -> None:
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    transcriber = _FakeTranscriber(
        lambda _audio, _ct: ("ok", TranscriptionResult(text="anything"))
    )
    service = ExtractionService(extractor=extractor, transcriber=transcriber)
    assert service.supports_voice is True


def test_supports_photo_false_without_vision_extractor() -> None:
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    service = ExtractionService(extractor=extractor)
    assert service.supports_photo is False


# ---- Photo capture path -------------------------------------------------


class _FakeVisionExtractor:
    """Test double for `VisionExtractorPort`.

    Structural conformance — no inheritance needed because
    `VisionExtractorPort` is a `Protocol`.
    """

    provider_name = "fake"

    def __init__(
        self,
        behaviour: Callable[[bytes, str], PhotoExtractionOutcome],
    ) -> None:
        self._behaviour = behaviour
        self.calls: list[tuple[bytes, str]] = []

    def extract_from_image(
        self, image: bytes, content_type: str
    ) -> PhotoExtractionOutcome:
        self.calls.append((image, content_type))
        return self._behaviour(image, content_type)


def _row(
    name: str = "Maria Lopez",
    *,
    confidence: Confidence = Confidence.HIGH,
    row_index: int | None = None,
    source_text: str | None = None,
    warnings: tuple[str, ...] = (),
) -> PhotoExtractionRow:
    """Build a photo row whose fields carry a single named lead.

    All other fields are HIGH-confidence None — the same "blank but
    valid" shape voice/text use in their own tests.
    """
    none = ExtractedField(value=None, confidence=Confidence.HIGH)
    fields = ExtractedFields(
        name=ExtractedField(value=name, confidence=Confidence.HIGH),
        phone=none,
        email=none,
        has_agent=none,
        intent=none,
        timeline=none,
        financing_status=none,
        budget=none,
        area=none,
        follow_up=none,
        notes=none,
    )
    return PhotoExtractionRow(
        fields=fields,
        source_text=source_text or name,
        row_index=row_index,
        confidence=confidence,
        warnings=warnings,
    )


def _photo_capture(
    image: bytes = b"\x89PNG\r\n\x1a\n",
    *,
    capture_id: str = "test000capt",
) -> PhotoCaptureInput:
    return PhotoCaptureInput(
        image=image, content_type="image/jpeg", capture_id=capture_id
    )


def test_photo_path_without_vision_extractor_yields_clean_error_event() -> None:
    """Mirrors the voice path's defence-in-depth check. Without a
    vision adapter, the service yields a clean error event rather
    than raising mid-stream."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    service = ExtractionService(extractor=extractor)  # no vision_extractor

    received = list(service.stream_photo_capture(_photo_capture()))

    assert len(received) == 1
    kind, payload = received[0]
    assert kind == "error"
    assert isinstance(payload, ExtractionError)
    assert payload.kind == ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def test_supports_photo_true_with_vision_extractor() -> None:
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    vision = _FakeVisionExtractor(
        lambda _img, _ct: ("ok", PhotoExtractionResult(rows=(_row(),))),
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)
    assert service.supports_photo is True


def test_photo_extraction_error_forwards_to_sse() -> None:
    """Vision adapter errors flow through as `error` events unchanged."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    vision = _FakeVisionExtractor(
        lambda _img, _ct: (
            "error",
            ExtractionError(
                kind=ExtractionErrorKind.UPSTREAM_RATE_LIMITED,
                detail="busy",
            ),
        )
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)

    received = list(service.stream_photo_capture(_photo_capture()))

    assert len(received) == 1
    kind, payload = received[0]
    assert kind == "error"
    assert isinstance(payload, ExtractionError)
    assert payload.kind == ExtractionErrorKind.UPSTREAM_RATE_LIMITED


def test_photo_with_zero_rows_yields_photo_done_no_signal() -> None:
    """Zero rows extracted → terminal `photo_done` with status
    `no_signal`. NOT an `error` event — extraction ran cleanly, the
    photo just had no readable data. Slice B's failure overlay
    branches on the status field; reserving `error` for true
    upstream failures keeps the surfaces distinct."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    vision = _FakeVisionExtractor(
        lambda _img, _ct: ("ok", PhotoExtractionResult(rows=())),
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)

    received = list(service.stream_photo_capture(_photo_capture()))

    assert len(received) == 1
    kind, payload = received[0]
    assert kind == "photo_done"
    assert isinstance(payload, PhotoDonePayload)
    assert payload.status == "no_signal"
    assert payload.total_rows == 0
    assert payload.provider == "fake"


def test_photo_with_one_row_yields_photo_row_then_photo_done() -> None:
    """Single-row case: one `photo_row` (densely-indexed, with a
    server-generated idempotency key) → terminal `photo_done` with
    status `ok`. Uniform shape across N — single-row and multi-row
    travel the same wire."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    only_row = _row(name="Jonathan", source_text="Jonathan, 555-0192")
    vision = _FakeVisionExtractor(
        lambda _img, _ct: ("ok", PhotoExtractionResult(rows=(only_row,))),
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)

    received = list(service.stream_photo_capture(_photo_capture()))

    assert [k for k, _ in received] == ["photo_row", "photo_done"]

    row_kind, row_payload = received[0]
    assert isinstance(row_payload, PhotoRowPayload)
    assert row_payload.row_index == 0
    assert row_payload.fields.name.value == "Jonathan"
    assert row_payload.idempotency_key.startswith("test000capt:0:")

    done_kind, done_payload = received[1]
    assert isinstance(done_payload, PhotoDonePayload)
    assert done_payload.status == "ok"
    assert done_payload.total_rows == 1
    assert done_payload.warnings == ()


def test_photo_with_multiple_rows_emits_all_rows_in_document_order() -> None:
    """Multi-row case (Slice C): every row reaches the wire as a
    `photo_row` event in document reading order, terminal
    `photo_done` carries the total count. No `multi_row_in_single_mode`
    advisory — step 8 IS the multi-row mode."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    rows = (
        _row(name="First", confidence=Confidence.LOW, row_index=0),
        _row(name="Second", confidence=Confidence.HIGH, row_index=1),
        _row(name="Third", confidence=Confidence.MEDIUM, row_index=2),
    )
    vision = _FakeVisionExtractor(
        lambda _img, _ct: ("ok", PhotoExtractionResult(rows=rows)),
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)

    received = list(service.stream_photo_capture(_photo_capture()))

    assert [k for k, _ in received] == [
        "photo_row",
        "photo_row",
        "photo_row",
        "photo_done",
    ]
    # Document order preserved; indices densified (0..N-1).
    names = [payload.fields.name.value for k, payload in received[:3] if isinstance(payload, PhotoRowPayload)]
    assert names == ["First", "Second", "Third"]
    indices = [payload.row_index for k, payload in received[:3] if isinstance(payload, PhotoRowPayload)]
    assert indices == [0, 1, 2]

    done_kind, done_payload = received[3]
    assert isinstance(done_payload, PhotoDonePayload)
    assert done_payload.status == "ok"
    assert done_payload.total_rows == 3


def test_photo_partial_status_when_signal_gate_drops_some_rows() -> None:
    """Mid-stream filter: rows that fail the signal gate are dropped,
    surviving rows are re-indexed densely (0..N-1), and the terminal
    `photo_done` reports `partial` with a `dropped_signal_gate:<n>`
    warning code. Don't drop Linda's data — emit what made it."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    none_field = ExtractedField(value=None, confidence=Confidence.HIGH)
    empty_fields = ExtractedFields(
        name=none_field,
        phone=none_field,
        email=none_field,
        has_agent=none_field,
        intent=none_field,
        timeline=none_field,
        financing_status=none_field,
        budget=none_field,
        area=none_field,
        follow_up=none_field,
        notes=none_field,
    )
    empty_row = PhotoExtractionRow(
        fields=empty_fields,
        source_text=None,
        row_index=1,
        confidence=Confidence.LOW,
        warnings=(),
    )
    rows = (
        _row(name="Alice", row_index=0),
        empty_row,  # dropped
        _row(name="Carol", row_index=2),
    )
    vision = _FakeVisionExtractor(
        lambda _img, _ct: ("ok", PhotoExtractionResult(rows=rows)),
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)

    received = list(service.stream_photo_capture(_photo_capture()))

    assert [k for k, _ in received] == ["photo_row", "photo_row", "photo_done"]
    names = [p.fields.name.value for _, p in received[:2] if isinstance(p, PhotoRowPayload)]
    assert names == ["Alice", "Carol"]
    indices = [p.row_index for _, p in received[:2] if isinstance(p, PhotoRowPayload)]
    assert indices == [0, 1]  # densified

    done_kind, done_payload = received[2]
    assert isinstance(done_payload, PhotoDonePayload)
    assert done_payload.status == "partial"
    assert done_payload.total_rows == 2
    assert "dropped_signal_gate:1" in done_payload.warnings


def test_photo_with_all_rows_failing_signal_gate_yields_no_signal() -> None:
    """All-empty rows → status `no_signal` (still `photo_done`, never
    `error`). Same surface Slice B's retake overlay watches."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    none_field = ExtractedField(value=None, confidence=Confidence.HIGH)
    empty_fields = ExtractedFields(
        name=none_field,
        phone=none_field,
        email=none_field,
        has_agent=none_field,
        intent=none_field,
        timeline=none_field,
        financing_status=none_field,
        budget=none_field,
        area=none_field,
        follow_up=none_field,
        notes=none_field,
    )
    empty_row = PhotoExtractionRow(
        fields=empty_fields,
        source_text=None,
        row_index=None,
        confidence=Confidence.LOW,
        warnings=(),
    )
    vision = _FakeVisionExtractor(
        lambda _img, _ct: ("ok", PhotoExtractionResult(rows=(empty_row,))),
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)

    received = list(service.stream_photo_capture(_photo_capture()))

    assert [k for k, _ in received] == ["photo_done"]
    kind, payload = received[0]
    assert isinstance(payload, PhotoDonePayload)
    assert payload.status == "no_signal"
    assert payload.total_rows == 0


def test_photo_level_warnings_forwarded_as_photo_warning_events() -> None:
    """Photo-level warnings (e.g. "image was crooked") flow as
    non-terminal `photo_warning` events BEFORE the rows. Carry the
    model's text under the generic `photo_advisory` code."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    vision = _FakeVisionExtractor(
        lambda _img, _ct: (
            "ok",
            PhotoExtractionResult(
                rows=(_row(),),
                warnings=(
                    "Image was crooked — results may be partial.",
                    "Bottom edge cropped.",
                ),
            ),
        ),
    )
    service = ExtractionService(extractor=extractor, vision_extractor=vision, image_preprocessor=_passthrough_preprocessor)

    received = list(service.stream_photo_capture(_photo_capture()))

    kinds = [k for k, _ in received]
    assert kinds == ["photo_warning", "photo_warning", "photo_row", "photo_done"]
    for i, expected_text in enumerate(
        ("Image was crooked — results may be partial.", "Bottom edge cropped.")
    ):
        kind, payload = received[i]
        assert kind == "photo_warning"
        assert isinstance(payload, StreamWarning)
        assert payload.code == "photo_advisory"
        assert payload.message == expected_text


# ---- Preprocessor wiring (7b) ------------------------------------------


@pytest.mark.parametrize(
    "kind",
    [
        ExtractionErrorKind.IMAGE_TOO_LARGE,
        ExtractionErrorKind.UNSUPPORTED_IMAGE,
        ExtractionErrorKind.IMAGE_DECODE_FAILED,
        ExtractionErrorKind.IMAGE_TOO_SMALL,
        ExtractionErrorKind.IMAGE_PREPROCESS_FAILED,
    ],
)
def test_preprocessor_failure_surfaces_as_sse_error(
    kind: ExtractionErrorKind,
) -> None:
    """Each image-specific preprocessor error kind flows through to
    a single SSE error event without ever touching the vision
    adapter. Parametrised across the full set so a new kind added
    later is automatically covered."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    vision_calls: list[tuple[bytes, str]] = []

    def _spy_vision(image: bytes, content_type: str) -> PhotoExtractionOutcome:
        vision_calls.append((image, content_type))
        return ("ok", PhotoExtractionResult(rows=(_row(),)))

    vision = _FakeVisionExtractor(_spy_vision)
    service = ExtractionService(
        extractor=extractor,
        vision_extractor=vision,
        image_preprocessor=_failing_preprocessor(kind),
    )

    received = list(service.stream_photo_capture(_photo_capture()))

    assert len(received) == 1
    received_kind, payload = received[0]
    assert received_kind == "error"
    assert isinstance(payload, ExtractionError)
    assert payload.kind is kind
    # Vision adapter never saw a request — preprocessor short-circuited.
    assert vision_calls == []


def test_preprocessor_success_hands_clean_bytes_to_vision_adapter() -> None:
    """Happy path through the wiring: the vision adapter receives the
    preprocessor's CLEANED bytes + the normalised content-type
    (`image/jpeg`), not the raw upload."""
    extractor = _FakeExtractor(lambda _: ("ok", ExtractionResult(_all_fields_high(), "x")))
    vision_calls: list[tuple[bytes, str]] = []

    def _spy_vision(image: bytes, content_type: str) -> PhotoExtractionOutcome:
        vision_calls.append((image, content_type))
        return ("ok", PhotoExtractionResult(rows=(_row(),)))

    vision = _FakeVisionExtractor(_spy_vision)

    cleaned_bytes = b"cleaned-and-normalised"

    def _clean_preprocessor(image: bytes, content_type: str) -> PreprocessOutcome:
        return (
            "ok",
            PreprocessedImage(
                bytes=cleaned_bytes,
                content_type="image/jpeg",
                width=800,
                height=600,
            ),
        )

    service = ExtractionService(
        extractor=extractor,
        vision_extractor=vision,
        image_preprocessor=_clean_preprocessor,
    )

    # Caller passes a raw HEIC upload labelled `image/heic`; the
    # vision adapter should see the CLEANED bytes and `image/jpeg`.
    raw_input = PhotoCaptureInput(
        image=b"raw-heic-bytes",
        content_type="image/heic",
        capture_id="raw00000capt",
    )
    received = list(service.stream_photo_capture(raw_input))

    assert [k for k, _ in received] == ["photo_row", "photo_done"]
    assert vision_calls == [(cleaned_bytes, "image/jpeg")]
