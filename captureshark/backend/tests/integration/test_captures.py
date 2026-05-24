"""End-to-end test for the captures endpoint.

Uses FastAPI's dependency-override hook to swap the production extractor for
an in-memory fake. No real OpenAI calls are made; we're verifying:

  * Request body is validated and rejected cleanly when malformed.
  * A successful extraction round-trips into the documented response shape.
  * Domain error kinds map to the right HTTP statuses + plain-English copy.
  * The streaming endpoint emits SSE frames in the right order + format.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import cast

from fastapi.testclient import TestClient

from captureshark.api.deps import get_text_extractor
from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionError,
    ExtractionErrorKind,
    ExtractionOutcome,
    ExtractionResult,
    ExtractorPort,
    StreamDelta,
    StreamEvent,
)
from captureshark.main import app


class _StubExtractor:
    def __init__(
        self,
        outcome: ExtractionOutcome,
        stream_events: list[StreamEvent] | None = None,
    ) -> None:
        self._outcome = outcome
        self._stream_events = stream_events or []

    def extract_from_text(self, text: str) -> ExtractionOutcome:
        return self._outcome

    def stream_from_text(self, text: str) -> Iterator[StreamEvent]:
        yield from self._stream_events


def _override_extractor(
    outcome: ExtractionOutcome,
    stream_events: list[StreamEvent] | None = None,
) -> None:
    app.dependency_overrides[get_text_extractor] = lambda: cast(
        ExtractorPort, _StubExtractor(outcome, stream_events)
    )


def _clear_overrides() -> None:
    app.dependency_overrides.clear()


def _parse_sse_frames(raw: str) -> list[tuple[str, dict[str, object]]]:
    """Parse an SSE stream body into a list of (event_name, json_data) tuples.

    Tolerates the test client returning the whole body as one string — splits
    on the blank-line frame terminator and pulls `event:` and `data:` lines.
    """
    frames: list[tuple[str, dict[str, object]]] = []
    for chunk in raw.strip().split("\n\n"):
        if not chunk:
            continue
        event_name = ""
        data_line = ""
        for line in chunk.split("\n"):
            if line.startswith("event: "):
                event_name = line[len("event: ") :]
            elif line.startswith("data: "):
                data_line = line[len("data: ") :]
        frames.append((event_name, json.loads(data_line)))
    return frames


def _success_outcome() -> ExtractionOutcome:
    high = ExtractedField(value="Jane Doe", confidence=Confidence.HIGH)
    blank = ExtractedField(value=None, confidence=Confidence.HIGH)
    fields = ExtractedFields(
        name=high,
        phone=ExtractedField(
            value="555-0192",
            confidence=Confidence.MEDIUM,
            alternatives=("555-0182",),
        ),
        email=blank,
        has_agent=blank,
        intent=blank,
        timeline=blank,
        financing_status=blank,
        area=blank,
        budget=blank,
        follow_up=blank,
        notes=blank,
    )
    return ("ok", ExtractionResult(fields=fields, original_text="Jane 555-0192"))


def test_text_capture_returns_extracted_fields() -> None:
    _override_extractor(_success_outcome())
    try:
        client = TestClient(app)
        response = client.post(
            "/api/v1/captures",
            json={"source": "text", "text": "Jane 555-0192"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["original_text"] == "Jane 555-0192"
        assert body["fields"]["name"]["value"] == "Jane Doe"
        assert body["fields"]["phone"]["confidence"] == "medium"
        assert body["fields"]["phone"]["alternatives"] == ["555-0182"]
        assert body["fields"]["email"]["value"] is None
    finally:
        _clear_overrides()


def test_rate_limit_maps_to_429_with_friendly_copy() -> None:
    err = ExtractionError(kind=ExtractionErrorKind.UPSTREAM_RATE_LIMITED, detail="busy")
    _override_extractor(("error", err))
    try:
        client = TestClient(app)
        response = client.post(
            "/api/v1/captures",
            json={"source": "text", "text": "hello"},
        )

        assert response.status_code == 429
        body = response.json()
        assert body["error"]["code"] == "ai_busy"
        assert "capacity" in body["error"]["message"].lower()
    finally:
        _clear_overrides()


def test_empty_text_is_rejected_by_request_validation() -> None:
    # Caught by Pydantic before reaching the service; FastAPI returns 422.
    client = TestClient(app)
    response = client.post(
        "/api/v1/captures",
        json={"source": "text", "text": ""},
    )
    assert response.status_code == 422


# --- Streaming endpoint --------------------------------------------------


def test_stream_emits_deltas_then_done_in_order() -> None:
    success = _success_outcome()
    assert success[0] == "ok"  # narrows the union for mypy
    success_result = success[1]
    stream_events: list[StreamEvent] = [
        ("delta", StreamDelta(content='{"name":')),
        ("delta", StreamDelta(content='{"value":"Jane Doe"')),
        ("done", success_result),
    ]
    _override_extractor(success, stream_events)
    try:
        client = TestClient(app)
        response = client.post(
            "/api/v1/captures/stream",
            json={"source": "text", "text": "Jane 555-0192"},
        )

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        frames = _parse_sse_frames(response.text)
        names = [name for name, _ in frames]
        assert names == ["delta", "delta", "done"]
        assert frames[0][1]["content"] == '{"name":'
        assert frames[2][1]["original_text"] == "Jane 555-0192"
        assert frames[2][1]["fields"]["name"]["value"] == "Jane Doe"  # type: ignore[index]
    finally:
        _clear_overrides()


def test_stream_emits_error_event_with_friendly_copy() -> None:
    err = ExtractionError(kind=ExtractionErrorKind.UPSTREAM_RATE_LIMITED, detail="busy")
    _override_extractor(("error", err), stream_events=[("error", err)])
    try:
        client = TestClient(app)
        response = client.post(
            "/api/v1/captures/stream",
            json={"source": "text", "text": "hello"},
        )

        # The HTTP response itself is 200 (the stream started); the failure
        # is delivered as the terminal `error` event in-band.
        assert response.status_code == 200
        frames = _parse_sse_frames(response.text)
        assert len(frames) == 1
        name, payload = frames[0]
        assert name == "error"
        assert payload["code"] == "ai_busy"
        message = payload["message"]
        assert isinstance(message, str)
        assert "capacity" in message.lower()
    finally:
        _clear_overrides()
