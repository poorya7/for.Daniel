"""HTTP request/response DTOs.

These Pydantic models describe the *wire shape* of the API, NOT domain
entities. Convert at the boundary:

    request DTO  →  domain object  →  service call
    service result  →  response DTO  →  HTTP response

Keeping these distinct from domain models means:
  * The HTTP shape can evolve without rippling into business logic.
  * Domain models stay free of HTTP-specific fields (camelCase aliases,
    versioned discriminators, etc.).
  * Renaming a domain field doesn't silently break API consumers.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from captureshark.domain.capture import CaptureSource
from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionResult,
    LeadFieldName,
)

# --- Errors ----------------------------------------------------------------


class ErrorBody(BaseModel):
    """Inner error body — the user-facing message and a machine-friendly code."""

    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    """Top-level error envelope — every non-2xx response uses this shape."""

    error: ErrorBody


# --- Captures: text path ---------------------------------------------------


class TextCaptureRequest(BaseModel):
    """Request body for `POST /api/v1/captures` with `source=text`."""

    model_config = ConfigDict(extra="forbid")

    source: CaptureSource = CaptureSource.TEXT
    text: str = Field(min_length=1, max_length=5000)


class ExtractedFieldDTO(BaseModel):
    """Wire shape of a single extracted field. Mirrors `ExtractedField`."""

    value: str | None
    confidence: Confidence
    alternatives: list[str]


class ExtractedFieldsDTO(BaseModel):
    """Wire shape of the full field set."""

    name: ExtractedFieldDTO
    phone: ExtractedFieldDTO
    email: ExtractedFieldDTO
    has_agent: ExtractedFieldDTO
    intent: ExtractedFieldDTO
    timeline: ExtractedFieldDTO
    financing_status: ExtractedFieldDTO
    budget: ExtractedFieldDTO
    area: ExtractedFieldDTO
    follow_up: ExtractedFieldDTO
    notes: ExtractedFieldDTO


class ExtractionResultDTO(BaseModel):
    """Successful extraction response.

    `original_text` is echoed back so the salvage path ("save the original
    note as a row anyway") doesn't require a second round-trip.
    """

    fields: ExtractedFieldsDTO
    original_text: str


def field_to_dto(field_value: ExtractedField) -> ExtractedFieldDTO:
    """Convert one domain field to its DTO. Public so routes stay one-liners."""
    return ExtractedFieldDTO(
        value=field_value.value,
        confidence=field_value.confidence,
        alternatives=list(field_value.alternatives),
    )


def fields_to_dto(fields_value: ExtractedFields) -> ExtractedFieldsDTO:
    """Convert the full field bundle to its DTO."""
    mapping = fields_value.as_mapping()
    return ExtractedFieldsDTO(
        name=field_to_dto(mapping[LeadFieldName.NAME]),
        phone=field_to_dto(mapping[LeadFieldName.PHONE]),
        email=field_to_dto(mapping[LeadFieldName.EMAIL]),
        has_agent=field_to_dto(mapping[LeadFieldName.HAS_AGENT]),
        intent=field_to_dto(mapping[LeadFieldName.INTENT]),
        timeline=field_to_dto(mapping[LeadFieldName.TIMELINE]),
        financing_status=field_to_dto(mapping[LeadFieldName.FINANCING_STATUS]),
        budget=field_to_dto(mapping[LeadFieldName.BUDGET]),
        area=field_to_dto(mapping[LeadFieldName.AREA]),
        follow_up=field_to_dto(mapping[LeadFieldName.FOLLOW_UP]),
        notes=field_to_dto(mapping[LeadFieldName.NOTES]),
    )


def result_to_dto(result: ExtractionResult) -> ExtractionResultDTO:
    """Convert a successful extraction result to its DTO."""
    return ExtractionResultDTO(
        fields=fields_to_dto(result.fields),
        original_text=result.original_text,
    )


# --- Sheets: save row ------------------------------------------------------


class SaveRowRequest(BaseModel):
    """Request body for `POST /api/v1/sheets/append`.

    The user may have edited the extracted fields before saving, so we accept
    the canonical field shape (not the extraction result envelope). All
    fields are optional — captures with only a few populated fields still
    deserve to be saved (per the v1 sketch's never-drop-data rule).

    `client_tz` is the browser's IANA timezone string (e.g. "America/Los_Angeles"),
    auto-attached by the frontend via `Intl.DateTimeFormat().resolvedOptions().timeZone`.
    The backend uses it to format the `Date Captured` cell in the user's
    local time rather than the server's. Optional + tolerant: invalid or
    absent zones fall back to UTC and log a single warning per request.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    phone: str | None = None
    email: str | None = None
    has_agent: str | None = None
    intent: str | None = None
    timeline: str | None = None
    financing_status: str | None = None
    area: str | None = None
    budget: str | None = None
    follow_up: str | None = None
    notes: str | None = None
    source: CaptureSource = CaptureSource.TEXT
    client_tz: str | None = Field(default=None, max_length=64)


class SheetTargetDTO(BaseModel):
    """User-facing identity of the sheet a row landed in.

    `display_name` powers the confirmation card copy (`"Saved to <name> ✅"`).
    `spreadsheet_id` is included so the frontend can link "Open in Google
    Sheets" without another round-trip.
    """

    spreadsheet_id: str
    display_name: str


class SaveRowResponse(BaseModel):
    """Successful save response."""

    target: SheetTargetDTO


# --- Sheets: connect (Picker) ---------------------------------------------


class ConnectSheetRequest(BaseModel):
    """Request body for `POST /api/v1/sheets/connect`.

    Frontend sends the spreadsheet identity it learned from the Google
    Picker selection. The backend persists it as the user's connected
    sheet — overwriting any previous pick (one-sheet-per-user in v1).
    """

    model_config = ConfigDict(extra="forbid")

    spreadsheet_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=512)
    worksheet_title: str = Field(default="Sheet1", min_length=1, max_length=256)


class ConnectedSheetDTO(BaseModel):
    """User-facing shape of a connected sheet — what the frontend reads
    from `/auth/me` and `/sheets/connect`."""

    spreadsheet_id: str
    display_name: str
    worksheet_title: str


class ConnectSheetResponse(BaseModel):
    """Response for `POST /api/v1/sheets/connect`."""

    connected_sheet: ConnectedSheetDTO


# --- Sheets: proposed column mapping (step 5) -----------------------------


class ColumnMappingDTO(BaseModel):
    """Wire shape of a `domain.column_mapping.ColumnMapping`.

    `fields` keys are the canonical lead-field names (matching
    `LeadField.value`); values are the header text in the user's sheet,
    or `null` if no auto-match was found. `unmapped_headers` lists any
    sheet headers we didn't claim (so the frontend can show *"these
    columns are in your sheet but we won't touch them"*).
    """

    fields: dict[str, str | None]
    unmapped_headers: list[str]


class MappingProposalDTO(BaseModel):
    """Wire shape of a `domain.column_mapping.MappingProposal`.

    Discriminated by `kind`:
      * `has_headers` → `mapping` populated, frontend shows the
        confirmation screen.
      * `empty`        → frontend prompts *"Want us to set up the
        headers for you?"*
      * `looks_like_data` → frontend prompts *"This sheet has data but
        no header row. Want us to insert one?"* and shows the row 1
        cells via `headers` so the user knows what we saw.
    """

    kind: str
    headers: list[str]
    mapping: ColumnMappingDTO | None


class ProposedMappingResponse(BaseModel):
    """Response for `GET /api/v1/sheets/proposed-mapping`."""

    proposal: MappingProposalDTO


class SaveMappingRequest(BaseModel):
    """Request body for `POST /api/v1/sheets/mapping`.

    Carries the user-confirmed `ColumnMapping` from the frontend. We
    accept it as-is rather than re-running auto-mapping server-side —
    the user might have used the (future) "Fix one" UI to override
    one of our guesses.

    `fields` keys MUST be the canonical lead-field names (see
    `LeadField` for the full set). Validation against the canonical
    set lives in the route layer (Pydantic can't enum-check dict
    keys cleanly).
    """

    model_config = ConfigDict(extra="forbid")

    fields: dict[str, str | None] = Field(
        description="lead-field-key -> sheet-header (or null if unmapped)",
    )
    unmapped_headers: list[str] = Field(default_factory=list)


class SaveMappingResponse(BaseModel):
    """Response for `POST /api/v1/sheets/mapping`. Echoes the saved mapping."""

    mapping: ColumnMappingDTO
