"""Integration tests for `POST /api/v1/client-errors`.

The endpoint exists so the React error boundary (lands in §7) can
report a frontend crash with enough detail to correlate against
backend logs. Its contract:

  * Returns 204 on success — body is empty.
  * Validates the payload shape (extra fields rejected; required
    `message` enforced; size caps respected).
  * Logs a structured warning carrying the client-side detail.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from captureshark.main import app


def test_valid_report_returns_204_and_logs_structured_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = TestClient(app)
    payload = {
        "message": "Cannot read property 'foo' of undefined",
        "component_stack": "at ReviewCard\n  at App",
        "build_version": "0.1.0+abc123",
        "last_request_id": "req-xyz",
        "user_agent": "Mozilla/5.0 (iPhone; ...)",
    }

    with caplog.at_level(
        logging.WARNING, logger="captureshark.api.routes.client_errors"
    ):
        response = client.post("/api/v1/client-errors", json=payload)

    assert response.status_code == 204
    assert response.content == b""

    # Structured log carries the client-side fields under predictable names.
    matching = [
        record
        for record in caplog.records
        if record.message == "client error reported"
        and getattr(record, "client_message", None) == payload["message"]
        and getattr(record, "client_last_request_id", None) == "req-xyz"
        and getattr(record, "client_build_version", None) == "0.1.0+abc123"
    ]
    assert matching, "Expected a structured `client error reported` warning"


def test_minimal_report_only_requires_message() -> None:
    """All fields except `message` are optional — partial reports are still useful."""
    client = TestClient(app)
    response = client.post(
        "/api/v1/client-errors",
        json={"message": "Something went sideways"},
    )
    assert response.status_code == 204


def test_empty_message_is_rejected() -> None:
    """`message` is min_length=1 — an empty string makes the log useless."""
    client = TestClient(app)
    response = client.post("/api/v1/client-errors", json={"message": ""})
    assert response.status_code == 422


def test_extra_fields_are_rejected() -> None:
    """`extra="forbid"` — unexpected fields shouldn't silently land in logs.

    Catches the case where a frontend ships a new field name we haven't
    audited for PII; we'd rather 422 it loudly than log it quietly.
    """
    client = TestClient(app)
    response = client.post(
        "/api/v1/client-errors",
        json={
            "message": "ok",
            "user_email": "broker@example.com",  # not in our schema
        },
    )
    assert response.status_code == 422


def test_oversize_message_is_rejected() -> None:
    """The `message` cap exists to prevent log-flood from a runaway loop."""
    client = TestClient(app)
    response = client.post(
        "/api/v1/client-errors",
        json={"message": "x" * 3000},  # cap is 2000
    )
    assert response.status_code == 422
