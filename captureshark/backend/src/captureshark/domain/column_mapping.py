"""Pure-domain logic for proposing a column mapping from a sheet's headers.

When a user picks a sheet via the Picker (step 4d), the app reads row 1
and tries to match each header to one of our canonical lead fields
(see `LeadField` below for the full set). The user then confirms ("Yes,
use these") or fixes any wrong guesses ("Fix one").

This module has no I/O. It takes a list of header strings, applies a
synonym table, and returns a `MappingProposal`. The Sheets-side reader
(adapter), the orchestrating service, and the API layer all live
elsewhere — this is the brain of the auto-mapping, isolated and
trivially testable.

Three classification outcomes for the row-1 read:

  * `has_headers` — row 1 looks like headers (short text values, no
    phones/emails/long blobs). Auto-match what we can; surface what we
    can't so the user can map it manually or send it to Notes.
  * `empty` — the sheet is genuinely empty (row 1 doesn't exist).
    Frontend prompts: *"Want us to set it up for you?"* (per spec §4
    "Empty sheet — don't auto-overwrite ambiguous data").
  * `looks_like_data` — row 1 exists but has phone-shaped /
    email-shaped / long-blob values. Treating these as headers would
    overwrite the user's data on first save, which is a hard-no per
    the same spec section. Frontend prompts: *"This sheet has data but
    no header row. Want us to insert one?"* — explicit consent before
    we touch anything.

Also exported here: `project_row_to_cells` — the inverse of
`propose_mapping`. Once the user has confirmed a mapping, every save
uses *live* headers (read fresh at save time) plus the persisted
mapping to place each lead-field value under the right column. Server-
stamped `Date Captured` / `Source` columns are auto-detected by header
name; columns we don't recognise stay empty so the user's untouched
columns aren't overwritten.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

if TYPE_CHECKING:
    from captureshark.domain.sheets import SheetRow


class LeadField(StrEnum):
    """Canonical app-side fields a sheet column can map to.

    These are the lead-data fields the user *cares* about — contact
    triple (name/phone/email), the qualification + prioritisation
    fields (has_agent / intent / timeline / financing_status / budget),
    plus the long-form preference fields (area / follow_up / notes).
    `Date Captured` and `Source` are server-stamped metadata;
    they're not in this enum because the user doesn't pick where they
    map (we always append them at the end of the row).

    Order mirrors `LeadFieldName` in `extraction.py` exactly — both
    derive the 3-page review-card layout from this single source of
    truth.
    """

    NAME = "name"
    PHONE = "phone"
    EMAIL = "email"
    HAS_AGENT = "has_agent"
    INTENT = "intent"
    TIMELINE = "timeline"
    FINANCING_STATUS = "financing_status"
    BUDGET = "budget"
    AREA = "area"
    FOLLOW_UP = "follow_up"
    NOTES = "notes"


@dataclass(frozen=True, slots=True)
class ColumnMapping:
    """Frozen map from `LeadField` to the header text in the user's sheet.

    A `None` value means we couldn't auto-match this field to any
    header — the frontend renders that as *"Not mapped — anything we
    capture for this will go in Notes."* Storing `None` explicitly (vs
    omitting the key) keeps the shape predictable for the API layer
    and the persistence layer that lands later.

    `unmapped_headers` are the sheet columns we DIDN'T claim. The
    review screen shows them so the user knows what's in their sheet
    but isn't being touched (spec: *"We'll put anything we're unsure
    about in Notes."* applies to the *fields*, not these columns).
    """

    fields: dict[LeadField, str | None]
    unmapped_headers: tuple[str, ...]


class MappingProposalKind(StrEnum):
    """Discriminator for what the API returns to the frontend.

    Three states correspond to three different UI screens — see this
    module's docstring for the spec mapping.
    """

    HAS_HEADERS = "has_headers"
    EMPTY = "empty"
    LOOKS_LIKE_DATA = "looks_like_data"


@dataclass(frozen=True, slots=True)
class MappingProposal:
    """The full proposal the API returns after reading row 1.

    `headers` is the raw row-1 strings (in column order) — useful for
    the `looks_like_data` UI which shows the user what we saw, and for
    `has_headers` so the frontend can render rows in the user's order.
    `mapping` is `None` for `EMPTY` and `LOOKS_LIKE_DATA` (no headers
    to map yet); populated for `HAS_HEADERS`.
    """

    kind: MappingProposalKind
    headers: tuple[str, ...]
    mapping: ColumnMapping | None


# --- Synonym table --------------------------------------------------------
#
# Maps `LeadField` to a tuple of normalised header strings that should
# auto-map to that field. The first entry is the canonical default
# header (what we'd auto-create on an empty sheet); the rest are
# common aliases. All entries are pre-normalised: lowercased, stripped
# of non-alphanumerics. The matcher normalises sheet headers the same
# way before lookup, so casing / spacing / punctuation in the user's
# sheet doesn't matter ("Tel.", "tel", "TEL" all match).
#
# Conservative on purpose: we only match exact normalised strings.
# Substring matching ("contact" → name?) creates surprises; users can
# always tap "Fix one" to override. v1.1 can layer in fuzzy / typo
# tolerance once we see real usage.
_SYNONYMS: Final[dict[LeadField, tuple[str, ...]]] = {
    LeadField.NAME: (
        "name",
        "fullname",
        "leadname",
        "clientname",
        "contactname",
        "contact",
        "lead",
        "person",
    ),
    LeadField.PHONE: (
        "phone",
        "phonenumber",
        "tel",
        "telephone",
        "cell",
        "cellphone",
        "mobile",
        "number",
    ),
    LeadField.EMAIL: (
        "email",
        "emailaddress",
        "mail",
        "eaddress",
    ),
    LeadField.HAS_AGENT: (
        "hasagent",
        "agent",
        "buyeragent",
        "buyersagent",
        "represented",
        "representation",
        "workingwithagent",
        "ownagent",
        "theiragent",
    ),
    LeadField.INTENT: (
        "intent",
        "type",
        "leadtype",
        "buyerorseller",
        "buyerseller",
        "lookingto",
        "purpose",
        "interest",
    ),
    LeadField.TIMELINE: (
        "timeline",
        "timeframe",
        "movetimeline",
        "movingby",
        "movewhen",
        "horizon",
        "when",
    ),
    LeadField.FINANCING_STATUS: (
        "financing",
        "financingstatus",
        "preapproval",
        "preapproved",
        "prequalified",
        "preapprovalstatus",
        "payment",
        "cashorlender",
        "mortgage",
        "mortgagestatus",
    ),
    LeadField.AREA: (
        "area",
        "neighborhood",
        "neighbourhood",
        "location",
        "areaofinterest",
        "interest",
        "where",
        "lookingin",
    ),
    LeadField.BUDGET: (
        "budget",
        "price",
        "pricerange",
        "maxbudget",
        "amount",
        "spend",
    ),
    LeadField.FOLLOW_UP: (
        "followup",
        "nextsteps",
        "deadline",
        "timing",
        "when",
        "followupdate",
    ),
    LeadField.NOTES: (
        "notes",
        "note",
        "comments",
        "comment",
        "remarks",
        "details",
        "info",
        "other",
    ),
}


# Default headers we'd auto-create on an empty sheet. Order matters —
# this is what the frontend shows and what the writer appends in. Mirrors
# `adapters/_sheets_row_format.VALUE_RANGE_COLS` minus the two
# server-stamped columns (which are auto-appended at the end).
DEFAULT_HEADERS: Final[tuple[str, ...]] = (
    "Name",
    "Phone",
    "Email",
    "Has Agent",
    "Intent",
    "Timeline",
    "Financing Status",
    "Budget",
    "Area",
    "Follow Up",
    "Notes",
)


# --- Public API -----------------------------------------------------------


def propose_mapping(headers: list[str]) -> MappingProposal:
    """Classify row 1 and (if it's headers) auto-match each app field.

    Pure function — no I/O, deterministic. Tests pin behaviour by
    feeding header lists directly.
    """
    if not headers or all(_is_blank(cell) for cell in headers):
        return MappingProposal(
            kind=MappingProposalKind.EMPTY,
            headers=tuple(headers),
            mapping=None,
        )
    if _looks_like_data(headers):
        return MappingProposal(
            kind=MappingProposalKind.LOOKS_LIKE_DATA,
            headers=tuple(headers),
            mapping=None,
        )
    return MappingProposal(
        kind=MappingProposalKind.HAS_HEADERS,
        headers=tuple(headers),
        mapping=_build_mapping(headers),
    )


def project_row_to_cells(
    row: SheetRow,
    *,
    headers: tuple[str, ...],
    mapping: ColumnMapping,
) -> list[str]:
    """Build the cells to send to Sheets, ordered to match the user's headers.

    For each column in `headers` (in order):
      * If the column is the one mapped to lead-field X, place X's value.
      * If the column header matches our `Date Captured` / `Source`
        meta-headers (case-insensitive), stamp those server-set values.
      * Otherwise, leave the cell empty so we don't overwrite whatever
        the user has in that column.

    The mapping stores the header *text* the user confirmed (e.g.
    `"Tel"` → phone). At save time the live headers are re-read from
    Sheets, so a sheet rename / re-order between confirm and save
    still places data under the right columns — as long as the header
    text the mapping pinned still exists in row 1. If it doesn't, that
    field's value drops to "" rather than landing in the wrong column;
    a future slice can surface this as a "your sheet changed — re-confirm
    mapping?" prompt.
    """
    # Reverse the mapping: header-text → which lead field uses it. We
    # normalise both sides so a casing tweak ("Phone" → "phone") doesn't
    # silently break the projection.
    header_to_field: dict[str, LeadField] = {}
    for field, header in mapping.fields.items():
        if header is None:
            continue
        header_to_field[_normalise(header)] = field

    field_values: dict[LeadField, str | None] = {
        LeadField.NAME: row.name,
        LeadField.PHONE: row.phone,
        LeadField.EMAIL: row.email,
        LeadField.HAS_AGENT: row.has_agent,
        LeadField.AREA: row.area,
        LeadField.BUDGET: row.budget,
        LeadField.FOLLOW_UP: row.follow_up,
        LeadField.NOTES: row.notes,
    }

    cells: list[str] = []
    for header in headers:
        normalised = _normalise(header)
        # 1. Lead-field column the user mapped.
        if normalised in header_to_field:
            value = field_values[header_to_field[normalised]]
            cells.append(value or "")
            continue
        # 2. Server-stamped meta columns auto-detected by name.
        if normalised in _DATE_HEADERS:
            cells.append(format_captured_at(row.captured_at))
            continue
        if normalised in _SOURCE_HEADERS:
            cells.append(row.source)
            continue
        # 3. Anything else — leave empty so we don't clobber user data.
        cells.append("")
    return cells


# Header names we'll stamp the captured-at / source value into,
# regardless of their position. Normalised forms only — the matcher
# strips casing + punctuation before lookup. Kept small on purpose:
# users naming a column "When was it captured" would have to map it
# manually to follow_up if they wanted the date there; auto-claiming
# loose synonyms here would surprise people.
_DATE_HEADERS: Final[frozenset[str]] = frozenset({
    "datecaptured",
    "captured",
    "date",
    "captureddate",
    "createdat",
})
_SOURCE_HEADERS: Final[frozenset[str]] = frozenset({
    "source",
    "capturesource",
    "channel",
    "via",
})


def resolve_zone(client_tz: str | None) -> ZoneInfo | None:
    """Resolve an IANA timezone string to a `ZoneInfo`, or `None`.

    `None` covers all "we couldn't honour this":
      * caller didn't send a tz
      * tz string is unknown to the system zoneinfo database
      * tz string is malformed in a way that raises `ValueError`

    Service-layer callers branch on `None` to decide whether to log
    a degraded-fallback line; the helper itself stays pure (no I/O,
    no logging) so it can live in `domain/`.
    """
    if not client_tz:
        return None
    try:
        return ZoneInfo(client_tz)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def format_captured_at(captured_at: datetime) -> str:
    """Friendly local format per v1 sketch §11 — "May 9, 2:30 PM".

    Public (no leading underscore) because the Sheets adapter imports
    this — it's the single source of truth for how the captured-at
    timestamp lands in the user's sheet, regardless of which write
    path (fixed-order legacy or mapped-column projection) produces it.

    Built via explicit construction rather than `strftime` + a
    leading-zero-strip hack because the previous implementation had
    a wrong slice bound *and* targeted the wrong digit (the regex
    matched the hour zero, not the day zero, and the slice cut off
    before either appeared). Direct construction is intention-revealing:
    a reader sees what each piece contributes.

    The `captured_at` argument is expected to carry the user's
    timezone already — the service layer is the seam where UTC gets
    converted to the user's IANA zone (per the request's `client_tz`
    field). This function does not reinterpret the zone; whatever
    tz the datetime carries, that's the wall-clock it formats.
    """
    hour_12 = captured_at.hour % 12 or 12
    return (
        f"{captured_at.strftime('%b')} {captured_at.day}, "
        f"{hour_12}:{captured_at.minute:02d} {captured_at.strftime('%p')}"
    )


# --- Internals ------------------------------------------------------------

# Phone-shape: at least 7 digits, optionally with separators / parens /
# leading +. Covers 555-0192, (555) 555-0192, +1-555-555-0192, etc.
_PHONE_SHAPE = re.compile(r"^\+?[\d().\s-]{7,}$")
# Email-shape: anything-with-an-@-and-a-dot. Conservative; we just need
# "this is data, not a header" not full RFC validation.
_EMAIL_SHAPE = re.compile(r"^\S+@\S+\.\S+$")
# Headers tend to be short. 40-char threshold is generous (covers
# "Area of Interest / Neighborhood Notes" style).
_HEADER_MAX_LEN: Final = 40


def _looks_like_data(headers: list[str]) -> bool:
    """Heuristic: does row 1 look like data rather than headers?

    Returns True if any non-blank cell looks phone-shaped, email-shaped,
    or is longer than `_HEADER_MAX_LEN`. One bad cell is enough to
    refuse to overwrite — better to ask than to clobber.
    """
    for cell in headers:
        stripped = cell.strip()
        if not stripped:
            continue
        if _PHONE_SHAPE.match(stripped):
            return True
        if _EMAIL_SHAPE.match(stripped):
            return True
        if len(stripped) > _HEADER_MAX_LEN:
            return True
    return False


def _build_mapping(headers: list[str]) -> ColumnMapping:
    """Match each `LeadField` to a header, claiming each header at most once."""
    claimed_indices: set[int] = set()
    fields: dict[LeadField, str | None] = {}

    # Match in enum order so behaviour is deterministic when two fields
    # could plausibly match the same header (rare given the synonym
    # table, but pin it anyway).
    for field in LeadField:
        match_index = _find_match(field, headers, claimed_indices)
        if match_index is None:
            fields[field] = None
        else:
            claimed_indices.add(match_index)
            fields[field] = headers[match_index]

    unmapped = tuple(
        headers[i].strip()
        for i in range(len(headers))
        if i not in claimed_indices and not _is_blank(headers[i])
    )
    return ColumnMapping(fields=fields, unmapped_headers=unmapped)


def _find_match(
    field: LeadField, headers: list[str], claimed: set[int]
) -> int | None:
    """First unclaimed header whose normalised form matches `field`'s synonyms."""
    synonyms = _SYNONYMS[field]
    for index, header in enumerate(headers):
        if index in claimed:
            continue
        normalised = _normalise(header)
        if normalised and normalised in synonyms:
            return index
    return None


def _normalise(header: str) -> str:
    """Lowercase + strip non-alphanumerics. *"Phone Number"* → `phonenumber`."""
    return re.sub(r"[^a-z0-9]", "", header.lower())


def _is_blank(cell: str) -> bool:
    return not cell.strip()
