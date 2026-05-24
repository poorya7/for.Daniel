"""End-to-end test for the voice capture endpoint.

Same DI-override pattern as `test_captures.py`: stub the extractor +
the transcriber so we don't hit OpenAI. The route exercises the
multipart upload, audio-size guard, transcription error translation,
and SSE event shape.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import cast

import pytest
from fastapi.testclient import TestClient

from captureshark.api.deps import get_text_extractor, get_voice_transcriber
from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionResult,
    ExtractorPort,
    StreamDelta,
    StreamEvent,
)
from captureshark.domain.transcription import (
    TranscriberPort,
    TranscriptionError,
    TranscriptionErrorKind,
    TranscriptionOutcome,
    TranscriptionResult,
)
from captureshark.main import app


class _StubExtractor:
    def __init__(self, stream_events: list[StreamEvent]) -> None:
        self._stream_events = stream_events
        self.stream_calls: list[str] = []

    def extract_from_text(self, text: str) -> object:  # unused on voice path
        raise AssertionError("text extract_from_text shouldn't be hit on voice path")

    def stream_from_text(self, text: str) -> Iterator[StreamEvent]:
        self.stream_calls.append(text)
        yield from self._stream_events


class _StubTranscriber:
    def __init__(self, outcome: TranscriptionOutcome) -> None:
        self._outcome = outcome
        self.calls: list[tuple[bytes, str]] = []

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptionOutcome:
        self.calls.append((audio, content_type))
        return self._outcome


@pytest.fixture(autouse=True)
def _clear_overrides() -> Iterator[None]:
    """Each test sets its own overrides; clear them on teardown."""
    yield
    app.dependency_overrides.clear()


def _wire(
    *,
    transcriber_outcome: TranscriptionOutcome,
    stream_events: list[StreamEvent] | None = None,
) -> tuple[_StubExtractor, _StubTranscriber]:
    extractor = _StubExtractor(stream_events or [])
    transcriber = _StubTranscriber(transcriber_outcome)
    app.dependency_overrides[get_text_extractor] = lambda: cast(
        ExtractorPort, extractor
    )
    app.dependency_overrides[get_voice_transcriber] = lambda: cast(
        TranscriberPort, transcriber
    )
    return extractor, transcriber


def _all_high_fields() -> ExtractedFields:
    none = ExtractedField(value=None, confidence=Confidence.HIGH)
    return ExtractedFields(
        name=ExtractedField(value="Maria Lopez", confidence=Confidence.HIGH),
        phone=none,
        email=none,
        has_agent=none,
        intent=none,
        timeline=none,
        financing_status=none,
        area=ExtractedField(value="Maple St", confidence=Confidence.HIGH),
        budget=none,
        follow_up=none,
        notes=none,
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


def test_voice_endpoint_streams_extractor_events_after_transcription() -> None:
    success = ExtractionResult(fields=_all_high_fields(), original_text="Maria Maple")
    events: list[StreamEvent] = [
        ("delta", StreamDelta(content='{"name":"Maria"}')),
        ("done", success),
    ]
    extractor, transcriber = _wire(
        transcriber_outcome=("ok", TranscriptionResult(text="Maria Maple")),
        stream_events=events,
    )

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/voice",
        files={"audio": ("clip.webm", b"\x00fake-audio", "audio/webm")},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    parsed = _parse_sse(response.text)
    assert [name for name, _ in parsed] == ["delta", "done"]
    assert parsed[0][1] == {"content": '{"name":"Maria"}'}
    # Transcriber saw the bytes + content-type; extractor was driven by the transcript.
    assert transcriber.calls == [(b"\x00fake-audio", "audio/webm")]
    assert extractor.stream_calls == ["Maria Maple"]


def test_voice_endpoint_translates_transcription_error_to_sse_error() -> None:
    _, transcriber = _wire(
        transcriber_outcome=(
            "error",
            TranscriptionError(
                kind=TranscriptionErrorKind.UPSTREAM_RATE_LIMITED,
                detail="busy",
            ),
        ),
        stream_events=[],
    )

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/voice",
        files={"audio": ("clip.webm", b"\x00\x01", "audio/webm")},
    )

    assert response.status_code == 200  # SSE 200 + error frame, not HTTP 4xx
    parsed = _parse_sse(response.text)
    assert len(parsed) == 1
    name, data = parsed[0]
    assert name == "error"
    assert data["code"] == "ai_busy"


def test_voice_endpoint_rejects_empty_audio_with_400() -> None:
    _wire(
        transcriber_outcome=("ok", TranscriptionResult(text="never used")),
        stream_events=[],
    )

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/voice",
        files={"audio": ("empty.webm", b"", "audio/webm")},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "empty_input"


def test_voice_endpoint_rejects_oversized_audio_with_413() -> None:
    _wire(
        transcriber_outcome=("ok", TranscriptionResult(text="never used")),
        stream_events=[],
    )

    client = TestClient(app)
    # 26 MB > 25 MB cap
    big_blob = b"\x00" * (26 * 1024 * 1024)
    response = client.post(
        "/api/v1/captures/voice",
        files={"audio": ("big.webm", big_blob, "audio/webm")},
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "audio_too_large"


def test_voice_endpoint_uses_form_content_type_override_when_provided() -> None:
    """Safari uploads tagged `application/octet-stream` — the form override
    lets the client tell us the real type."""
    success = ExtractionResult(fields=_all_high_fields(), original_text="hi")
    _, transcriber = _wire(
        transcriber_outcome=("ok", TranscriptionResult(text="hi")),
        stream_events=[("done", success)],
    )

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/voice",
        files={"audio": ("clip.bin", b"\x00\x01", "application/octet-stream")},
        data={"content_type": "audio/mp4"},
    )

    assert response.status_code == 200
    # Override won — transcriber saw mp4, not octet-stream.
    assert transcriber.calls == [(b"\x00\x01", "audio/mp4")]


def test_voice_endpoint_returns_503_when_transcriber_not_configured() -> None:
    """Capability-guard backport: refuse cleanly with 503 JSON BEFORE
    opening the SSE response when no transcriber is wired.

    Pre-7a, this code path raised `RuntimeError` inside the streaming
    iterator — the client saw status 200 + headers sent + then a
    broken stream. The backport closes that gap so voice and photo
    handle "adapter not configured" identically.
    """
    extractor = _StubExtractor([])
    app.dependency_overrides[get_text_extractor] = lambda: cast(
        ExtractorPort, extractor
    )
    # No transcriber wired — service.supports_voice should be False.
    app.dependency_overrides[get_voice_transcriber] = lambda: cast(
        TranscriberPort | None, None
    )

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/voice",
        files={"audio": ("clip.webm", b"\x00\x01", "audio/webm")},
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "capture_not_configured"
