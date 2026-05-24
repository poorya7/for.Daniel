"""End-to-end test for the photo capture endpoint.

Same DI-override pattern as `test_captures_voice.py`: stub the
text extractor + the vision extractor so we don't hit any real
upstream APIs. The route exercises the multipart upload, the
image-size guard, the capability guard, error translation, and
SSE event shape (including the `warning` event introduced for
the multi-row-in-single-mode case).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import cast

import pytest
from fastapi.testclient import TestClient

from captureshark.adapters.image_preprocessor import (
    PreprocessOutcome,
    PreprocessedImage,
)
from captureshark.api.deps import (
    get_image_preprocessor,
    get_text_extractor,
    get_vision_extractor,
    get_voice_transcriber,
)
from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionError,
    ExtractionErrorKind,
    ExtractionResult,
    ExtractorPort,
    StreamEvent,
)
from captureshark.domain.transcription import TranscriberPort
from captureshark.domain.vision import (
    PhotoExtractionOutcome,
    PhotoExtractionResult,
    PhotoExtractionRow,
    VisionExtractorPort,
)
from captureshark.main import app


class _StubExtractor:
    """Stub `ExtractorPort` — text path is never hit on the photo
    route, but the service requires an extractor so we wire a no-op
    stub to keep the construction happy."""

    def __init__(self, stream_events: list[StreamEvent] | None = None) -> None:
        self._stream_events = stream_events or []

    def extract_from_text(self, text: str) -> object:
        raise AssertionError("extract_from_text shouldn't be hit on photo path")

    def stream_from_text(self, text: str) -> Iterator[StreamEvent]:
        yield from self._stream_events


class _StubVisionExtractor:
    """Configurable stub `VisionExtractorPort`."""

    provider_name = "stub"

    def __init__(self, outcome: PhotoExtractionOutcome) -> None:
        self._outcome = outcome
        self.calls: list[tuple[bytes, str]] = []

    def extract_from_image(
        self, image: bytes, content_type: str
    ) -> PhotoExtractionOutcome:
        self.calls.append((image, content_type))
        return self._outcome


@pytest.fixture(autouse=True)
def _clear_overrides() -> Iterator[None]:
    """Each test sets its own overrides; clear them on teardown."""
    yield
    app.dependency_overrides.clear()


def _passthrough_preprocessor(image: bytes, content_type: str) -> PreprocessOutcome:
    """Test stub: pretends the preprocessor cleaned the bytes.

    Keeps integration tests focused on route + service routing
    rather than real Pillow decode (which has its own dedicated
    test file at `tests/unit/test_image_preprocessor.py`). Always
    returns `image/jpeg` to match the production contract.
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


def _wire(
    *,
    vision_outcome: PhotoExtractionOutcome | None,
) -> _StubVisionExtractor | None:
    """Wire the test stubs into the FastAPI app.

    `vision_outcome=None` means "leave the vision extractor un-wired"
    — used to exercise the route-layer capability guard, which should
    return 503 before any extraction is attempted.
    """
    extractor = _StubExtractor()
    app.dependency_overrides[get_text_extractor] = lambda: cast(
        ExtractorPort, extractor
    )
    # Voice path isn't exercised here; wire a None transcriber so the
    # service constructs cleanly. The `get_voice_transcriber` factory
    # already returns Optional, so this matches its signature.
    app.dependency_overrides[get_voice_transcriber] = lambda: cast(
        TranscriberPort | None, None
    )
    # The photo path runs the preprocessor before the vision adapter.
    # Stub it so we can feed fake image bytes without burning Pillow
    # decode time on every test.
    app.dependency_overrides[get_image_preprocessor] = lambda: _passthrough_preprocessor

    if vision_outcome is None:
        # Route should refuse via supports_photo capability guard.
        app.dependency_overrides[get_vision_extractor] = lambda: cast(
            VisionExtractorPort | None, None
        )
        return None

    vision = _StubVisionExtractor(vision_outcome)
    app.dependency_overrides[get_vision_extractor] = lambda: cast(
        VisionExtractorPort | None, vision
    )
    return vision


def _all_high_fields(name: str = "Maria Lopez") -> ExtractedFields:
    none = ExtractedField(value=None, confidence=Confidence.HIGH)
    return ExtractedFields(
        name=ExtractedField(value=name, confidence=Confidence.HIGH),
        phone=none,
        email=none,
        has_agent=none,
        intent=none,
        timeline=none,
        financing_status=none,
        budget=none,
        area=ExtractedField(value="Maple St", confidence=Confidence.HIGH),
        follow_up=none,
        notes=none,
    )


def _row(name: str = "Maria Lopez") -> PhotoExtractionRow:
    return PhotoExtractionRow(
        fields=_all_high_fields(name),
        source_text=f"{name}, Maple St",
        row_index=None,
        confidence=Confidence.HIGH,
        warnings=(),
    )


def _parse_sse(body: str) -> list[tuple[str, dict[str, object]]]:
    """Parse an SSE stream body into a list of `(event_name, data_obj)` tuples."""
    events: list[tuple[str, dict[str, object]]] = []
    for frame in body.split("\n\n"):
        if not frame.strip():
            continue
        event_name = ""
        data_payload = ""
        for line in frame.splitlines():
            if line.startswith("event:"):
                event_name = line.removeprefix("event:").strip()
            elif line.startswith("data:"):
                data_payload = line.removeprefix("data:").strip()
        events.append((event_name, json.loads(data_payload)))
    return events


# ---- Capability guard ---------------------------------------------------


def test_photo_endpoint_returns_503_when_vision_not_configured() -> None:
    """Capability guard: refuse cleanly BEFORE opening the SSE response.

    With no vision adapter wired, the route should return JSON 503
    rather than start a stream that immediately errors. This is the
    contract that lets the frontend show a calm "photo capture isn't
    available" surface instead of fighting a broken stream.
    """
    _wire(vision_outcome=None)

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("clip.jpg", b"\xff\xd8\xff\xe0fake-jpeg", "image/jpeg")},
    )

    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == "capture_not_configured"


# ---- Happy path ---------------------------------------------------------


def test_photo_endpoint_streams_photo_row_then_photo_done_for_single_row() -> None:
    """Single-row happy path on the wire: one `photo_row` SSE frame
    (with the server-generated idempotency key + row fields) then a
    terminal `photo_done` carrying status `ok`, total_rows 1, and
    the provider name. No deltas (photo uses its own vocabulary —
    no per-field deltas)."""
    vision = _wire(
        vision_outcome=(
            "ok",
            PhotoExtractionResult(rows=(_row(name="Jonathan"),)),
        )
    )
    assert vision is not None

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("clip.jpg", b"\xff\xd8\xff\xe0fake-jpeg", "image/jpeg")},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    parsed = _parse_sse(response.text)
    assert [name for name, _ in parsed] == ["photo_row", "photo_done"]

    row_data = cast(dict[str, object], parsed[0][1])
    assert row_data["row_index"] == 0
    assert isinstance(row_data["idempotency_key"], str)
    assert row_data["idempotency_key"].endswith(  # capture_id is route-minted; just check shape
        # Format: <capture_id>:<row_index>:<sha8>
        # capture_id and sha8 are run-dependent, but the structure is fixed.
        "" # noqa — just asserting the field exists above; structural check below.
    )
    parts = row_data["idempotency_key"].split(":")
    assert len(parts) == 3
    assert parts[1] == "0"
    assert len(parts[2]) == 8
    fields = cast(dict[str, dict[str, object]], row_data["fields"])
    assert fields["name"]["value"] == "Jonathan"

    done_data = cast(dict[str, object], parsed[1][1])
    assert done_data["status"] == "ok"
    assert done_data["total_rows"] == 1
    assert done_data["provider"] == "stub"
    assert done_data["warnings"] == []

    # Vision was called with the right bytes + content-type.
    assert len(vision.calls) == 1
    assert vision.calls[0][1] == "image/jpeg"


def test_photo_endpoint_emits_a_photo_row_for_every_row_in_document_order() -> None:
    """Multi-row case (Slice C): every row reaches the wire as its
    own `photo_row` event in document reading order. Terminal
    `photo_done` reports `total_rows=N` with status `ok`. No
    `multi_row_in_single_mode` advisory — step 8 IS the multi-row
    mode."""
    rows = (
        PhotoExtractionRow(
            fields=_all_high_fields(name="First"),
            source_text="First",
            row_index=0,
            confidence=Confidence.LOW,
            warnings=(),
        ),
        PhotoExtractionRow(
            fields=_all_high_fields(name="Second"),
            source_text="Second",
            row_index=1,
            confidence=Confidence.HIGH,
            warnings=(),
        ),
    )
    _wire(vision_outcome=("ok", PhotoExtractionResult(rows=rows)))

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("sheet.jpg", b"\xff\xd8\xff\xe0sheet", "image/jpeg")},
    )

    assert response.status_code == 200
    parsed = _parse_sse(response.text)
    names = [name for name, _ in parsed]
    assert names == ["photo_row", "photo_row", "photo_done"]

    first = cast(dict[str, object], parsed[0][1])
    second = cast(dict[str, object], parsed[1][1])
    assert first["row_index"] == 0
    assert second["row_index"] == 1
    assert cast(dict[str, dict[str, object]], first["fields"])["name"]["value"] == "First"
    assert cast(dict[str, dict[str, object]], second["fields"])["name"]["value"] == "Second"

    done_data = cast(dict[str, object], parsed[2][1])
    assert done_data["status"] == "ok"
    assert done_data["total_rows"] == 2


def test_photo_endpoint_emits_photo_warning_for_image_level_advisories() -> None:
    """Image-level model advisories ("image was crooked") arrive as
    non-terminal `photo_warning` SSE events BEFORE the rows, under
    the generic `photo_advisory` code."""
    result = PhotoExtractionResult(
        rows=(_row(name="Catherine"),),
        warnings=("Image was crooked — results may be partial.",),
    )
    _wire(vision_outcome=("ok", result))

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("crooked.jpg", b"\xff\xd8\xff\xe0crooked", "image/jpeg")},
    )

    parsed = _parse_sse(response.text)
    names = [name for name, _ in parsed]
    assert names == ["photo_warning", "photo_row", "photo_done"]
    warning_data = cast(dict[str, object], parsed[0][1])
    assert warning_data["code"] == "photo_advisory"
    assert warning_data["message"] == "Image was crooked — results may be partial."


# ---- Error mapping ------------------------------------------------------


def test_photo_endpoint_rejects_empty_image_with_400() -> None:
    _wire(
        vision_outcome=("ok", PhotoExtractionResult(rows=(_row(),)))
    )

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("empty.jpg", b"", "image/jpeg")},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "empty_input"


def test_photo_endpoint_rejects_oversized_image_with_413() -> None:
    _wire(
        vision_outcome=("ok", PhotoExtractionResult(rows=(_row(),)))
    )

    client = TestClient(app)
    # 11 MB > 10 MB cap.
    big_blob = b"\xff" * (11 * 1024 * 1024)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("big.jpg", big_blob, "image/jpeg")},
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "image_too_large"


def test_photo_endpoint_translates_no_signal_to_photo_done_status() -> None:
    """Zero-row extraction surfaces as a terminal `photo_done` with
    status `no_signal` — NOT an `error` event. Extraction ran fine,
    the photo just had no readable data. Slice B's failure overlay
    branches on the status field; reserving `error` for true upstream
    failures keeps the surfaces distinct on the wire."""
    _wire(vision_outcome=("ok", PhotoExtractionResult(rows=())))

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("blank.jpg", b"\xff\xd8\xff\xe0blank", "image/jpeg")},
    )

    assert response.status_code == 200  # SSE 200 + terminal frame
    parsed = _parse_sse(response.text)
    assert len(parsed) == 1
    name, data = parsed[0]
    assert name == "photo_done"
    assert data["status"] == "no_signal"
    assert data["total_rows"] == 0


def test_photo_endpoint_translates_vision_upstream_error_to_sse_error() -> None:
    """Vision adapter errors flow through to SSE error frames with
    the appropriate `_ERROR_TABLE` mapping (e.g. moderation refusal
    → `image_moderation`)."""
    _wire(
        vision_outcome=(
            "error",
            ExtractionError(
                kind=ExtractionErrorKind.IMAGE_MODERATION_REFUSED,
                detail="refused",
            ),
        )
    )

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("flagged.jpg", b"\xff\xd8\xff\xe0", "image/jpeg")},
    )

    assert response.status_code == 200
    parsed = _parse_sse(response.text)
    assert len(parsed) == 1
    name, data = parsed[0]
    assert name == "error"
    assert data["code"] == "image_moderation"


def test_photo_endpoint_surfaces_preprocessor_error_as_sse_error_frame() -> None:
    """A preprocessor error (e.g. unsupported format detected after
    magic-number sniff) surfaces as an SSE `error` event with the
    right machine code — distinct from the route-layer 400/413
    rejections that fire BEFORE the SSE stream opens.

    `unsupported_image` is the user-facing code; the underlying
    domain kind (`UNSUPPORTED_IMAGE` or `IMAGE_DECODE_FAILED`)
    both map to it.
    """
    extractor = _StubExtractor()
    app.dependency_overrides[get_text_extractor] = lambda: cast(
        ExtractorPort, extractor
    )
    app.dependency_overrides[get_voice_transcriber] = lambda: cast(
        TranscriberPort | None, None
    )
    vision = _StubVisionExtractor(("ok", PhotoExtractionResult(rows=(_row(),))))
    app.dependency_overrides[get_vision_extractor] = lambda: cast(
        VisionExtractorPort | None, vision
    )

    def _failing_preprocessor(image: bytes, content_type: str) -> PreprocessOutcome:
        return (
            "error",
            ExtractionError(
                kind=ExtractionErrorKind.UNSUPPORTED_IMAGE,
                detail="format not in supported set",
            ),
        )

    app.dependency_overrides[get_image_preprocessor] = lambda: _failing_preprocessor

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("garbage.bin", b"not an image at all" + b"\x00" * 32, "image/jpeg")},
    )

    assert response.status_code == 200  # SSE 200 + error frame
    parsed = _parse_sse(response.text)
    assert len(parsed) == 1
    name, data = parsed[0]
    assert name == "error"
    assert data["code"] == "unsupported_image"
    # Vision adapter never saw a call — preprocessor short-circuited.
    assert vision.calls == []


def test_photo_endpoint_threads_content_type_override_to_preprocessor() -> None:
    """Form field `content_type` wins over the multipart upload's MIME
    when supplied — same behaviour the voice route already implements
    for browsers that mislabel blobs.

    The override flows: route → `PhotoCaptureInput` → preprocessor's
    content-type hint argument. The preprocessor doesn't TRUST the
    hint (it sniffs magic-number bytes), but the route still has to
    thread it correctly so logs + the hint reach the preprocessor.
    """
    extractor = _StubExtractor()
    app.dependency_overrides[get_text_extractor] = lambda: cast(
        ExtractorPort, extractor
    )
    app.dependency_overrides[get_voice_transcriber] = lambda: cast(
        TranscriberPort | None, None
    )
    vision = _StubVisionExtractor(("ok", PhotoExtractionResult(rows=(_row(),))))
    app.dependency_overrides[get_vision_extractor] = lambda: cast(
        VisionExtractorPort | None, vision
    )

    # Spy preprocessor: captures the content-type hint it was called
    # with so the assertion can verify routing.
    seen_hints: list[str] = []

    def _spy_preprocessor(image: bytes, content_type: str) -> PreprocessOutcome:
        seen_hints.append(content_type)
        return (
            "ok",
            PreprocessedImage(
                bytes=image,
                content_type="image/jpeg",
                width=800,
                height=600,
            ),
        )

    app.dependency_overrides[get_image_preprocessor] = lambda: _spy_preprocessor

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/photo",
        files={"image": ("clip.bin", b"\xff\xd8\xff\xe0", "application/octet-stream")},
        data={"content_type": "image/heic"},
    )

    assert response.status_code == 200
    # Preprocessor saw the form-field override, not the multipart MIME.
    assert seen_hints == ["image/heic"]
