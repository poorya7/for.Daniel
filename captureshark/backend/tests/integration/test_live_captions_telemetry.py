"""Integration tests for `POST /api/v1/telemetry/live-captions`.

Endpoint shape mirrors the client-errors pattern — a bounded JSON
payload becomes a structured log record. Contract:

  * 204 on success, body empty.
  * Validates the payload shape: `extra="forbid"`, required fields
    enforced, numeric bounds respected, size caps respected.
  * Emits a structured `info` log carrying every metric under
    predictable `lc_*` field names so dashboards can scrape it.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient

from captureshark.main import app


def _valid_payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "session_id": "11111111-2222-3333-4444-555555555555",
        "provider": "assemblyai",
        "outcome": "streamed",
        "total_session_ms": 18_400,
        "first_partial_ms": 820,
        "partial_count": 7,
        "p90_inter_partial_ms": 3_100,
        "max_inter_partial_ms": 3_350,
        "transcript_length": 142,
        "error_kind": None,
        "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2) AppleWebKit/...",
    }
    base.update(overrides)
    return base


def test_valid_payload_returns_204_and_logs_structured_record(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = TestClient(app)
    payload = _valid_payload()

    with caplog.at_level(
        logging.INFO,
        logger="captureshark.api.routes.live_captions_telemetry",
    ):
        response = client.post("/api/v1/telemetry/live-captions", json=payload)

    assert response.status_code == 204
    assert response.content == b""

    matching = [
        record
        for record in caplog.records
        if record.message == "live captions telemetry"
        and getattr(record, "lc_session_id", None) == payload["session_id"]
        and getattr(record, "lc_outcome", None) == "streamed"
        and getattr(record, "lc_first_partial_ms", None) == 820
        and getattr(record, "lc_partial_count", None) == 7
        and getattr(record, "lc_p90_inter_partial_ms", None) == 3_100
        and getattr(record, "lc_max_inter_partial_ms", None) == 3_350
        and getattr(record, "lc_transcript_length", None) == 142
    ]
    assert matching, "Expected a structured `live captions telemetry` info log"


def test_minimal_payload_accepts_nulls_for_unmeasured_fields() -> None:
    """Outcome=error / stopped sessions skip partial metrics legitimately."""
    client = TestClient(app)
    response = client.post(
        "/api/v1/telemetry/live-captions",
        json=_valid_payload(
            outcome="error",
            first_partial_ms=None,
            partial_count=0,
            p90_inter_partial_ms=None,
            max_inter_partial_ms=None,
            transcript_length=0,
            error_kind="connect_timeout",
        ),
    )
    assert response.status_code == 204


def test_unknown_provider_is_rejected() -> None:
    """Provider is constrained — typo'd values shouldn't pollute dashboards."""
    client = TestClient(app)
    response = client.post(
        "/api/v1/telemetry/live-captions",
        json=_valid_payload(provider="assemblyay"),
    )
    assert response.status_code == 422


def test_unknown_outcome_is_rejected() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/telemetry/live-captions",
        json=_valid_payload(outcome="finished"),
    )
    assert response.status_code == 422


def test_extra_fields_are_rejected() -> None:
    """`extra="forbid"` blocks a new client field landing in logs unaudited."""
    client = TestClient(app)
    response = client.post(
        "/api/v1/telemetry/live-captions",
        json={**_valid_payload(), "transcript_text": "Maria, 555-0192"},
    )
    assert response.status_code == 422


def test_missing_required_field_is_rejected() -> None:
    payload = _valid_payload()
    payload.pop("session_id")
    client = TestClient(app)
    response = client.post("/api/v1/telemetry/live-captions", json=payload)
    assert response.status_code == 422


def test_session_id_min_length_enforced() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/telemetry/live-captions",
        json=_valid_payload(session_id="short"),
    )
    assert response.status_code == 422


def test_negative_duration_is_rejected() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/telemetry/live-captions",
        json=_valid_payload(total_session_ms=-1),
    )
    assert response.status_code == 422


def test_oversize_user_agent_is_rejected() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/telemetry/live-captions",
        json=_valid_payload(user_agent="x" * 1000),
    )
    assert response.status_code == 422
