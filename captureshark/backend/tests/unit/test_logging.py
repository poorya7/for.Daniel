"""Unit tests for the logging infrastructure.

Covers two pure-ish concerns:

1. `RequestIdFilter` injects the active contextvar onto every record,
   falling back to "-" when no request scope is active.
2. `configure_logging` installs a JSON formatter that renders records
   as valid single-line JSON with the expected field names. We don't
   re-test python-json-logger itself; we *do* pin the field renames
   (`asctime → timestamp`, `levelname → level`, `name → logger`) and
   the inclusion of `request_id` because those are the contracts our
   downstream aggregators index against.
"""

from __future__ import annotations

import contextvars
import json
import logging
from typing import Any

import pytest

from captureshark.api.logging_config import RequestIdFilter, configure_logging

# We borrow the same contextvar by importing through the middleware
# module — the filter reads it via `current_request_id()`, so any path
# that sets it lands in the filter's output.
from captureshark.api.middleware.request_id import _request_id_var

# --- RequestIdFilter ------------------------------------------------------


def test_filter_uses_dash_when_no_request_scope() -> None:
    """Outside a request, the filter renders `request_id="-"`."""
    record = _make_record("hello")
    RequestIdFilter().filter(record)
    assert record.__dict__["request_id"] == "-"


def test_filter_picks_up_bound_request_id() -> None:
    """Inside a contextvar binding, the filter copies the bound value."""
    token = _request_id_var.set("abc-123")
    try:
        record = _make_record("hello")
        RequestIdFilter().filter(record)
        assert record.__dict__["request_id"] == "abc-123"
    finally:
        _request_id_var.reset(token)


def test_filter_isolates_per_async_context() -> None:
    """Each `contextvars.copy_context()` lookup sees its own bound value."""
    seen: dict[str, Any] = {}

    def in_context_a() -> None:
        token = _request_id_var.set("ctx-a")
        try:
            record = _make_record("from a")
            RequestIdFilter().filter(record)
            seen["a"] = record.__dict__["request_id"]
        finally:
            _request_id_var.reset(token)

    def in_context_b() -> None:
        token = _request_id_var.set("ctx-b")
        try:
            record = _make_record("from b")
            RequestIdFilter().filter(record)
            seen["b"] = record.__dict__["request_id"]
        finally:
            _request_id_var.reset(token)

    contextvars.copy_context().run(in_context_a)
    contextvars.copy_context().run(in_context_b)

    assert seen == {"a": "ctx-a", "b": "ctx-b"}


# --- configure_logging output -------------------------------------------


def test_configure_logging_emits_valid_json_with_renamed_fields(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Each log line is a JSON object with the renamed field set."""
    configure_logging(level=logging.INFO)
    logger = logging.getLogger("captureshark.tests.logging_unit")

    token = _request_id_var.set("req-xyz")
    try:
        logger.warning("structured event", extra={"status": 503})
    finally:
        _request_id_var.reset(token)

    captured = capsys.readouterr().out.strip().splitlines()
    payload = _parse_last_json_line(captured)

    # Renamed-field contract.
    assert payload["level"] == "WARNING"
    assert payload["logger"] == "captureshark.tests.logging_unit"
    assert "timestamp" in payload
    # `request_id` joined from the contextvar-driven filter.
    assert payload["request_id"] == "req-xyz"
    # `extra` keys land at the top level — what aggregators index on.
    assert payload["status"] == 503
    # Message preserved verbatim — formatter does not interpolate.
    assert payload["message"] == "structured event"


def test_configure_logging_is_idempotent(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Re-running `configure_logging` doesn't double up handlers.

    Important for tests that re-import `main` or worker processes that
    reload modules — without idempotency the same record would land in
    `stdout` N times.
    """
    configure_logging(level=logging.INFO)
    configure_logging(level=logging.INFO)
    configure_logging(level=logging.INFO)

    logger = logging.getLogger("captureshark.tests.logging_idempotent")
    logger.warning("once please")

    captured = capsys.readouterr().out.strip().splitlines()
    # Filter to the lines we just emitted — capsys may include other
    # records from prior tests that haven't drained yet.
    ours = [
        line
        for line in captured
        if "once please" in line and "logging_idempotent" in line
    ]
    assert len(ours) == 1, f"Expected exactly one log line, got {len(ours)}: {ours}"


# --- Helpers --------------------------------------------------------------


def _make_record(message: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="captureshark.tests",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=None,
        exc_info=None,
    )


def _parse_last_json_line(lines: list[str]) -> dict[str, Any]:
    """Find the last JSON-shaped line in `lines` (skip non-JSON noise).

    `capsys` can pick up output from other components in the test
    process; we want our specific structured event. JSON lines start
    with `{` so a quick filter is enough.
    """
    json_lines = [line for line in lines if line.startswith("{")]
    assert json_lines, f"No JSON output captured. Raw lines: {lines}"
    parsed = json.loads(json_lines[-1])
    assert isinstance(parsed, dict)
    return parsed
