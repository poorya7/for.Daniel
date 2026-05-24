"""Sheets domain — pure types describing how a captured lead lands in a sheet.

This module has no dependencies on adapters, frameworks, or I/O. It defines:

  * `SheetRow` — the canonical shape of one row written to the user's sheet.
    Field-name parity with `LeadFieldName` is intentional; the sheet adapter
    is the place where domain field-names get mapped to actual column letters
    or header names.
  * `SheetTarget` — a resolved sheet identity (id + worksheet tab + sheet
    name for confirmation copy). Step 3 hardcodes one dev target; later
    steps replace this with the user's connected sheet.
  * `SheetsRepoPort` — the Protocol adapters implement. Services depend on
    this interface; the Google adapter (or a fake) is one implementation.
  * `SheetWriteOutcome` — discriminated success/error result. Same
    errors-as-data pattern as the extraction domain.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal, Protocol, runtime_checkable

from captureshark.domain.column_mapping import ColumnMapping, MappingProposal


@dataclass(frozen=True, slots=True)
class SheetRow:
    """One row destined for the user's sheet.

    Field-for-field parity with `LeadFieldName` plus two server-stamped
    columns (`captured_at`, `source`). All values are stored as the strings
    the user will see in the cell — formatting / normalisation happens at
    the boundary, NOT here.

    `captured_at` is stored as an ISO-formatted string for easy
    serialisation; the adapter formats it as a friendly local "May 7, 2:30
    PM" string when writing. Storing the raw datetime keeps the domain
    free of locale concerns.
    """

    name: str | None
    phone: str | None
    email: str | None
    has_agent: str | None
    intent: str | None
    timeline: str | None
    financing_status: str | None
    budget: str | None
    area: str | None
    follow_up: str | None
    notes: str | None
    captured_at: datetime
    source: str  # "text" | "voice" | "photo" — kept as str so adapter can format


@dataclass(frozen=True, slots=True)
class SheetTarget:
    """Identifies the sheet a write is going to.

    `spreadsheet_id` is the Google Sheets file ID; `worksheet_title` names
    the tab within that file (defaults to the first tab — wrap in
    `GoogleSheetsRepo` rather than hardcoding here). `display_name` is the
    user-facing sheet name shown in the confirmation card ("Saved to
    Open House Leads ✅").
    """

    spreadsheet_id: str
    worksheet_title: str
    display_name: str


class SheetsErrorKind(StrEnum):
    """Coarse error categories — adapter classifies, API translates to copy.

    `AUTH_EXPIRED` vs `PERMISSION_DENIED` is the load-bearing
    distinction: Google's 401 means the access token is dead → user
    re-signs-in. Google's 403 means signed-in but not allowed on this
    specific sheet → user fixes sheet sharing. Conflating them lands
    the broker on the wrong recovery path (the §5 split is what fixed
    this — see docs/_logs/2026-05-10_review_cleanup_plan_v2.md §5).
    """

    NOT_FOUND = "not_found"  # sheet was deleted / moved / wrong id (incl. 410)
    PERMISSION_DENIED = "permission_denied"  # 403: signed-in, not allowed
    AUTH_EXPIRED = "auth_expired"  # 401: token dead, re-sign-in needed
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"  # network / Google down / 5xx
    UPSTREAM_RATE_LIMITED = "upstream_rate_limited"
    UNEXPECTED = "unexpected"


@dataclass(frozen=True, slots=True)
class SheetWriteError:
    """Error-shape of a sheet write attempt."""

    kind: SheetsErrorKind
    detail: str


@dataclass(frozen=True, slots=True)
class SheetWriteSuccess:
    """Success-shape of a sheet write attempt.

    `target` is echoed back so the API can render the confirmation card
    ("Saved to <display_name> ✅") without a second round-trip.
    """

    target: SheetTarget


SheetWriteOutcome = (
    tuple[Literal["ok"], SheetWriteSuccess] | tuple[Literal["error"], SheetWriteError]
)


@runtime_checkable
class SheetsRepoPort(Protocol):
    """Adapter interface: append one row to a sheet."""

    def append_row(self, target: SheetTarget, row: SheetRow) -> SheetWriteOutcome:
        """Append `row` to the bottom of the named worksheet in `target`.

        Implementations MUST return a result; they MUST NOT raise on
        recoverable upstream failure (timeouts, rate limits, permission
        errors). Programmer errors (bad types in our own code) may still
        bubble — those are bugs, not data.
        """
        ...


# --- User-picked sheet (step 4d) ------------------------------------------


@dataclass(frozen=True, slots=True)
class SheetConnection:
    """The Google Sheet a signed-in user picked via the Picker.

    1:1 with `User` for v1. Re-running the Picker overwrites the row
    (that's *Change sheet* from the persistent header). Includes the
    `display_name` captured at pick time so the confirmation card
    ("It's in Open House Leads now.") doesn't need a Sheets API call
    on every save.

    `header_mapping` is set to `None` until the user confirms the
    mapping screen (step 5b). A connection with `header_mapping=None`
    is treated as legacy / pre-mapping — saves fall back to the
    fixed-order writer. Once the user confirms, every subsequent save
    reads live headers and projects through this stored mapping.
    """

    user_id: int
    spreadsheet_id: str
    display_name: str
    worksheet_title: str
    header_mapping: ColumnMapping | None
    created_at: datetime
    updated_at: datetime

    def to_target(self) -> SheetTarget:
        """Project to a `SheetTarget` for the write path. Convenience
        — the writer doesn't need user-scoped fields, just the address."""
        return SheetTarget(
            spreadsheet_id=self.spreadsheet_id,
            worksheet_title=self.worksheet_title,
            display_name=self.display_name,
        )


@runtime_checkable
class SheetConnectionRepoPort(Protocol):
    """Find / upsert / revoke the per-user picked-sheet record."""

    async def get_for_user(self, user_id: int) -> SheetConnection | None:
        """Return the user's connected sheet, or `None` if they haven't picked one."""
        ...

    async def upsert_for_user(
        self,
        *,
        user_id: int,
        spreadsheet_id: str,
        display_name: str,
        worksheet_title: str = "Sheet1",
    ) -> SheetConnection:
        """Insert-or-replace this user's sheet pick. Idempotent on `user_id`.

        Resets `header_mapping` to `None` — picking a (potentially
        different) sheet invalidates whatever mapping the previous
        sheet had. The mapping confirmation screen runs again next.
        """
        ...

    async def update_mapping_for_user(
        self,
        *,
        user_id: int,
        mapping: ColumnMapping,
    ) -> SheetConnection:
        """Set the persisted header mapping for the user's existing
        connection. Raises `LookupError` if the user has no connection
        — the caller (route layer) is expected to ensure connect ran first.
        """
        ...

    async def delete_for_user(self, user_id: int) -> None:
        """Revoke the connection — `Disconnect` from the persistent header."""
        ...


# --- User-OAuth Sheets writer (step 4d) -----------------------------------
#
# A separate port from `SheetsRepoPort` because the credential model is
# fundamentally different: the dev path holds a service-account
# Resource for the lifetime of the process; the user path takes a fresh
# access token per call (each user has their own, and tokens expire).
# Mashing both into one Protocol would force the service-account
# adapter to ignore an `access_token` parameter and the user adapter
# to ignore a process-wide credential — both are smells.


@runtime_checkable
class UserSheetsWriterPort(Protocol):
    """Append pre-composed cells to a user-picked sheet using their OAuth token."""

    async def append_cells(
        self,
        *,
        access_token: str,
        target: SheetTarget,
        cells: list[str],
    ) -> SheetWriteOutcome:
        """Append `cells` (one row's worth, column-ordered) to `target`.

        The orchestrating service composes `cells` — using either the
        user's persisted column mapping or the legacy fixed-order
        helper. The writer adapter just sends them. Splitting this
        responsibility out of the writer means the same adapter works
        whether the user has confirmed a mapping or not, and the
        composition logic is testable in pure-domain isolation.

        Same errors-as-data contract as `SheetsRepoPort.append_row`.
        Token refresh is the *caller's* job — this port assumes the
        `access_token` it receives is already valid.
        """
        ...


# --- User-OAuth header reader (step 5) ------------------------------------
#
# Separate Port from `UserSheetsWriterPort` — Interface Segregation.
# Reading row 1 to propose a mapping is a different concern from
# appending rows; conflating them would force the writer adapter to
# grow a method it doesn't need (and vice versa). They're both still
# user-OAuth concerns so they live in the same module.


@dataclass(frozen=True, slots=True)
class SheetHeaderReadSuccess:
    """Success-shape of a row-1 read.

    `headers` preserves column order (index 0 = column A) and includes
    blank cells as empty strings so the proposer can detect *"sheet has
    rows but no header text"* the same way it detects empty sheets.
    """

    headers: tuple[str, ...]


SheetHeaderReadOutcome = (
    tuple[Literal["ok"], SheetHeaderReadSuccess]
    | tuple[Literal["error"], SheetWriteError]
)


@runtime_checkable
class SheetHeaderReaderPort(Protocol):
    """Read row 1 of a user-picked sheet using their own OAuth token."""

    async def read_headers(
        self,
        *,
        access_token: str,
        target: SheetTarget,
    ) -> SheetHeaderReadOutcome:
        """Return the cells of row 1 of `target`'s worksheet.

        Same errors-as-data contract as `UserSheetsWriterPort.append_row`
        — reuses `SheetWriteError` because the failure modes are
        identical (network, 401, 403, 404, 429). Token refresh is the
        caller's job.
        """
        ...


# --- User-save outcome (orchestrating-service shape) ----------------------
#
# `SheetWriteOutcome` describes one write attempt. The user-side
# orchestrating service (token refresh + connection lookup + write) has
# more failure modes than a single write — we model them as additional
# outcome variants instead of squashing them into a single "write
# failed" because the *frontend reaction is different* per case (the
# no-connection case opens the Picker; the no-tokens case kicks the
# user back to sign-in; a real write error shows a retry).


class UserSaveErrorKind(StrEnum):
    """Categories that the orchestrating user-save service can return."""

    NO_CONNECTION = "no_connection"
    """User is signed in but hasn't picked a sheet via the Picker yet."""

    NO_TOKENS = "no_tokens"
    """Session is valid but the OAuth token row is gone — re-auth needed."""

    REFRESH_FAILED = "refresh_failed"
    """Token refresh against Google failed (token revoked, network)."""


@dataclass(frozen=True, slots=True)
class UserSaveError:
    """Errors-as-data for the orchestrating service."""

    kind: UserSaveErrorKind
    detail: str


# Three-way outcome: success, write-level failure (passed through from
# the writer), and orchestrator-level failure (this service's own
# concerns). The route layer pattern-matches on the outer tag.
UserSaveOutcome = (
    tuple[Literal["ok"], SheetWriteSuccess]
    | tuple[Literal["write_error"], SheetWriteError]
    | tuple[Literal["orchestrator_error"], UserSaveError]
)


# --- User-mapping outcome (step 5 — propose-mapping service shape) --------
#
# Mirrors `UserSaveOutcome` for the *read-headers + propose-mapping*
# flow. Reuses `SheetWriteError` (read-side failures share status →
# error mapping with writes) and `UserSaveError` (NO_CONNECTION /
# NO_TOKENS / REFRESH_FAILED apply to any user-OAuth Sheets op, not
# just saves). The success branch carries the proposal directly.

UserMappingOutcome = (
    tuple[Literal["ok"], MappingProposal]
    | tuple[Literal["read_error"], SheetWriteError]
    | tuple[Literal["orchestrator_error"], UserSaveError]
)
