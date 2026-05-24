"""Sheets service — orchestrates "save extracted fields as a row".

Step 3 of the build wires this end-to-end against a single hardcoded dev
target; later steps will source the target from the user's connected sheet
record. Service surface stays the same either way:

    service.save_lead(...)  →  SheetWriteOutcome

Cross-cutting concerns that belong here (not in the adapter, not in the
route) include:
  * Stamping `captured_at` from an injected clock so tests can pin the time.
  * Localising `captured_at` to the user's IANA zone (per the request's
    `client_tz` field) so the `Date Captured` cell reads in the broker's
    local time rather than the server's UTC.
  * Selecting the active sheet target. Once multi-sheet support lands the
    target lookup grows up; for v1 dev there is exactly one.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from captureshark.domain.sheets import (
    SheetRow,
    SheetsRepoPort,
    SheetTarget,
    SheetWriteOutcome,
)
from captureshark.services._date_helpers import localise_captured_at


class SheetsService:
    """Use-case service for saving a captured lead to the user's sheet."""

    def __init__(
        self,
        *,
        repo: SheetsRepoPort,
        target: SheetTarget,
        clock: Callable[[], datetime],
    ) -> None:
        self._repo = repo
        self._target = target
        self._clock = clock

    def save_lead(
        self,
        *,
        name: str | None,
        phone: str | None,
        email: str | None,
        has_agent: str | None,
        intent: str | None,
        timeline: str | None,
        financing_status: str | None,
        area: str | None,
        budget: str | None,
        follow_up: str | None,
        notes: str | None,
        source: str,
        client_tz: str | None = None,
    ) -> SheetWriteOutcome:
        row = SheetRow(
            name=_clean(name),
            phone=_clean(phone),
            email=_clean(email),
            has_agent=_clean(has_agent),
            intent=_clean(intent),
            timeline=_clean(timeline),
            financing_status=_clean(financing_status),
            area=_clean(area),
            budget=_clean(budget),
            follow_up=_clean(follow_up),
            notes=_clean(notes),
            captured_at=localise_captured_at(self._clock(), client_tz),
            source=source,
        )
        return self._repo.append_row(self._target, row)


def _clean(value: str | None) -> str | None:
    """Trim and normalise empty strings to `None`."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None
