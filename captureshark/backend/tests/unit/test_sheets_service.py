"""Service-layer tests for `SheetsService`.

The service's job is small: assemble a `SheetRow` from the (possibly
user-edited) fields, stamp the time from the injected clock, and delegate
to the repo. Real API behaviour is exercised by the adapter tests.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from captureshark.domain.sheets import (
    SheetRow,
    SheetsErrorKind,
    SheetTarget,
    SheetWriteError,
    SheetWriteOutcome,
    SheetWriteSuccess,
)
from captureshark.services.sheets_service import SheetsService


class _FakeRepo:
    """Captures every append call so tests can assert on what was written."""

    def __init__(
        self, outcome_factory: Callable[[SheetTarget, SheetRow], SheetWriteOutcome]
    ) -> None:
        self._outcome_factory = outcome_factory
        self.calls: list[tuple[SheetTarget, SheetRow]] = []

    def append_row(self, target: SheetTarget, row: SheetRow) -> SheetWriteOutcome:
        self.calls.append((target, row))
        return self._outcome_factory(target, row)


_FIXED_TIME = datetime(2026, 5, 7, 14, 30, tzinfo=UTC)
_TARGET = SheetTarget(
    spreadsheet_id="abc123", worksheet_title="Sheet1", display_name="Open House Leads"
)


def _ok_factory(target: SheetTarget, row: SheetRow) -> SheetWriteOutcome:
    _ = row
    return ("ok", SheetWriteSuccess(target=target))


def test_service_builds_row_from_fields_and_stamps_time() -> None:
    repo = _FakeRepo(_ok_factory)
    service = SheetsService(repo=repo, target=_TARGET, clock=lambda: _FIXED_TIME)

    outcome = service.save_lead(
        name="  Jane Doe  ",
        phone="555-0192",
        email=None,
        has_agent=None,
        intent=None,
        timeline=None,
        financing_status=None,
        area="Maple St",
        budget="600k",
        follow_up="next Tuesday",
        notes="",
        source="text",
    )

    assert outcome[0] == "ok"
    assert len(repo.calls) == 1
    written_target, written_row = repo.calls[0]
    assert written_target == _TARGET
    # Trim and empty-to-None normalisation happens in the service layer.
    assert written_row.name == "Jane Doe"
    assert written_row.notes is None
    assert written_row.captured_at == _FIXED_TIME
    assert written_row.source == "text"


def test_service_forwards_repo_error() -> None:
    err = SheetWriteError(kind=SheetsErrorKind.PERMISSION_DENIED, detail="nope")
    repo = _FakeRepo(lambda _t, _r: ("error", err))
    service = SheetsService(repo=repo, target=_TARGET, clock=lambda: _FIXED_TIME)

    outcome = service.save_lead(
        name="x",
        phone=None,
        email=None,
        has_agent=None,
        intent=None,
        timeline=None,
        financing_status=None,
        area=None,
        budget=None,
        follow_up=None,
        notes=None,
        source="text",
    )

    assert outcome == ("error", err)
