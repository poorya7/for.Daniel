"""Unit tests for `services/_date_helpers.localise_captured_at`.

Three branches:
  * `client_tz` is a valid IANA name → conversion happens.
  * `client_tz` is missing (None / empty) → input passes through, no log.
  * `client_tz` is present but unknown → input passes through *and* a
    warning logs (so a persistent stream of bad zone strings stays
    visible without leaking PII).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from captureshark.services._date_helpers import localise_captured_at

_UTC_MOMENT = datetime(2026, 5, 9, 21, 30, tzinfo=UTC)


def test_localises_to_known_zone() -> None:
    out = localise_captured_at(_UTC_MOMENT, "America/Los_Angeles")
    assert out.tzinfo == ZoneInfo("America/Los_Angeles")
    # 21:30 UTC → 14:30 PT (PDT is UTC-7).
    assert out.hour == 14
    assert out.minute == 30


def test_returns_input_unchanged_when_tz_is_none() -> None:
    out = localise_captured_at(_UTC_MOMENT, None)
    assert out == _UTC_MOMENT


def test_returns_input_unchanged_when_tz_is_empty_string() -> None:
    out = localise_captured_at(_UTC_MOMENT, "")
    assert out == _UTC_MOMENT


def test_unknown_tz_falls_back_to_input(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Bad zone string → input passes through *and* a warning logs.

    The bad zone is carried in `extra={"client_tz": ...}` so it lands as
    a structured field in JSON output; the assertion reads it off the
    record attribute the same way the JSON formatter would.
    """
    with caplog.at_level(logging.WARNING, logger="captureshark.services._date_helpers"):
        out = localise_captured_at(_UTC_MOMENT, "Mars/Olympus_Mons")
    assert out == _UTC_MOMENT
    matching = [
        record
        for record in caplog.records
        if "Unrecognised client_tz" in record.message
        and getattr(record, "client_tz", None) == "Mars/Olympus_Mons"
    ]
    assert matching, "Expected a structured warning for the unknown tz"


def test_no_log_when_client_tz_absent(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Absent (None) tz is the normal path for non-Intl clients — no log noise."""
    with caplog.at_level(logging.WARNING, logger="captureshark.services._date_helpers"):
        localise_captured_at(_UTC_MOMENT, None)
    assert not any(
        "Unrecognised client_tz" in record.message for record in caplog.records
    )
