"""Pure-domain tests for `propose_mapping`.

The auto-mapping logic is the brain of step 5 — if it gets a "Tel" →
phone wrong, the broker sees a wrong-looking proposal on the screen
and her trust takes a hit. So we pin behaviour with explicit cases:

  * Canonical defaults (Name, Phone, ...) round-trip cleanly.
  * Common synonyms map ("Tel" → phone, "Lead Name" → name).
  * Casing / spacing / punctuation in headers doesn't matter.
  * Headers we don't recognise come back as `unmapped_headers`, not
    silently swallowed or mis-claimed.
  * Row-1 detection: empty / data / headers — each yields the right
    `MappingProposalKind`.

These are pure functions, so the tests are tiny and fast. Add cases
liberally as we run into real-world headers that should map but don't.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from captureshark.domain.column_mapping import (
    ColumnMapping,
    LeadField,
    MappingProposalKind,
    format_captured_at,
    project_row_to_cells,
    propose_mapping,
    resolve_zone,
)
from captureshark.domain.sheets import SheetRow

# --- has_headers — default / canonical case --------------------------------


def test_canonical_default_headers_map_one_to_one() -> None:
    proposal = propose_mapping(
        [
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
        ]
    )

    assert proposal.kind == MappingProposalKind.HAS_HEADERS
    assert proposal.mapping is not None
    assert proposal.mapping.fields == {
        LeadField.NAME: "Name",
        LeadField.PHONE: "Phone",
        LeadField.EMAIL: "Email",
        LeadField.HAS_AGENT: "Has Agent",
        LeadField.INTENT: "Intent",
        LeadField.TIMELINE: "Timeline",
        LeadField.FINANCING_STATUS: "Financing Status",
        LeadField.BUDGET: "Budget",
        LeadField.AREA: "Area",
        LeadField.FOLLOW_UP: "Follow Up",
        LeadField.NOTES: "Notes",
    }
    assert proposal.mapping.unmapped_headers == ()


def test_casing_and_punctuation_do_not_matter() -> None:
    proposal = propose_mapping(["NAME", "phone-number", "E-Mail", "follow_up"])

    assert proposal.mapping is not None
    fields = proposal.mapping.fields
    assert fields[LeadField.NAME] == "NAME"
    assert fields[LeadField.PHONE] == "phone-number"
    assert fields[LeadField.EMAIL] == "E-Mail"
    assert fields[LeadField.FOLLOW_UP] == "follow_up"


# --- has_headers — common synonyms (the spec calls these out) --------------


def test_tel_maps_to_phone() -> None:
    """Spec example: 'Tel' → phone."""
    proposal = propose_mapping(["Name", "Tel"])

    assert proposal.mapping is not None
    assert proposal.mapping.fields[LeadField.PHONE] == "Tel"


def test_lead_name_maps_to_name() -> None:
    """Spec example: 'Lead Name' → name."""
    proposal = propose_mapping(["Lead Name", "Phone"])

    assert proposal.mapping is not None
    assert proposal.mapping.fields[LeadField.NAME] == "Lead Name"


def test_real_estate_synonyms() -> None:
    proposal = propose_mapping(
        [
            "Contact",
            "Cell",
            "Mail",
            "Buyer Agent",
            "Neighborhood",
            "Price Range",
            "Timing",
            "Comments",
        ]
    )

    assert proposal.mapping is not None
    assert proposal.mapping.fields == {
        LeadField.NAME: "Contact",
        LeadField.PHONE: "Cell",
        LeadField.EMAIL: "Mail",
        LeadField.HAS_AGENT: "Buyer Agent",
        LeadField.INTENT: None,
        LeadField.TIMELINE: None,
        LeadField.FINANCING_STATUS: None,
        LeadField.AREA: "Neighborhood",
        LeadField.BUDGET: "Price Range",
        LeadField.FOLLOW_UP: "Timing",
        LeadField.NOTES: "Comments",
    }


# --- has_headers — partial / unmapped --------------------------------------


def test_unrecognised_headers_become_unmapped() -> None:
    proposal = propose_mapping(["Name", "Phone", "Source", "Lead Score"])

    assert proposal.mapping is not None
    assert proposal.mapping.fields[LeadField.NAME] == "Name"
    assert proposal.mapping.fields[LeadField.PHONE] == "Phone"
    assert proposal.mapping.fields[LeadField.EMAIL] is None
    assert proposal.mapping.unmapped_headers == ("Source", "Lead Score")


def test_each_header_claimed_at_most_once() -> None:
    """Two synonyms that could both claim the same header — only the first wins."""
    # "Contact" matches NAME synonyms. There's no second NAME-claimable
    # column, so this just confirms claim-once semantics by checking
    # NAME claims "Contact" and unmapped stays empty.
    proposal = propose_mapping(["Contact", "Phone"])

    assert proposal.mapping is not None
    assert proposal.mapping.fields[LeadField.NAME] == "Contact"
    assert proposal.mapping.unmapped_headers == ()


# --- empty -----------------------------------------------------------------


def test_empty_list_classified_as_empty() -> None:
    proposal = propose_mapping([])

    assert proposal.kind == MappingProposalKind.EMPTY
    assert proposal.mapping is None
    assert proposal.headers == ()


def test_all_blank_cells_classified_as_empty() -> None:
    proposal = propose_mapping(["", "  ", "\t"])

    assert proposal.kind == MappingProposalKind.EMPTY
    assert proposal.mapping is None


# --- looks_like_data -------------------------------------------------------


def test_phone_in_row_one_classified_as_data() -> None:
    """Spec §4: don't auto-overwrite. Phone in row 1 → it's data, not headers."""
    proposal = propose_mapping(["Maria Lopez", "555-0192", "maria@example.com"])

    assert proposal.kind == MappingProposalKind.LOOKS_LIKE_DATA
    assert proposal.mapping is None
    assert proposal.headers == ("Maria Lopez", "555-0192", "maria@example.com")


def test_email_in_row_one_classified_as_data() -> None:
    proposal = propose_mapping(["Name", "Phone", "user@example.com"])

    assert proposal.kind == MappingProposalKind.LOOKS_LIKE_DATA


def test_long_blob_in_row_one_classified_as_data() -> None:
    long_value = "Met at the open house, said she'd call back next Tuesday afternoon"
    proposal = propose_mapping(["Name", long_value])

    assert proposal.kind == MappingProposalKind.LOOKS_LIKE_DATA


def test_parenthesised_phone_classified_as_data() -> None:
    proposal = propose_mapping(["Maria Lopez", "(555) 555-0192"])

    assert proposal.kind == MappingProposalKind.LOOKS_LIKE_DATA


# --- robustness ------------------------------------------------------------


def test_blank_cells_between_headers_dont_break_mapping() -> None:
    """Some real sheets have padding columns. Blanks should be ignored, not panicked over."""
    proposal = propose_mapping(["Name", "", "Phone", " ", "Email"])

    assert proposal.kind == MappingProposalKind.HAS_HEADERS
    assert proposal.mapping is not None
    assert proposal.mapping.fields[LeadField.NAME] == "Name"
    assert proposal.mapping.fields[LeadField.PHONE] == "Phone"
    assert proposal.mapping.fields[LeadField.EMAIL] == "Email"
    assert proposal.mapping.unmapped_headers == ()


def test_mapping_is_deterministic_for_equivalent_inputs() -> None:
    """Same headers in → same proposal out. Catches accidental dict-order leaks."""
    inputs = ["Name", "Phone", "Email"]
    first = propose_mapping(inputs)
    second = propose_mapping(inputs)

    assert first == second


# --- project_row_to_cells -------------------------------------------------


_FIXED_TIME = datetime(2026, 5, 9, 14, 30, tzinfo=UTC)


def _row(**overrides: str | None) -> SheetRow:
    """Helper — build a `SheetRow` with sensible defaults so each test
    only spells out the fields that matter to it."""
    base: dict[str, str | None] = {
        "name": "Maria Lopez",
        "phone": "555-0192",
        "email": "maria@example.com",
        "has_agent": None,
        "intent": None,
        "timeline": None,
        "financing_status": None,
        "area": "Maple St",
        "budget": "600k",
        "follow_up": "next Tue",
        "notes": None,
    }
    base.update(overrides)
    return SheetRow(
        captured_at=_FIXED_TIME,
        source="text",
        **base,
    )


def test_project_places_each_field_under_its_mapped_header() -> None:
    """The user mapped Tel→phone, Lead Name→name. Cells should land accordingly."""
    mapping = ColumnMapping(
        fields={
            LeadField.NAME: "Lead Name",
            LeadField.PHONE: "Tel",
            LeadField.EMAIL: "Email",
            LeadField.AREA: None,
            LeadField.BUDGET: None,
            LeadField.FOLLOW_UP: None,
            LeadField.NOTES: None,
        },
        unmapped_headers=(),
    )
    headers = ("Tel", "Lead Name", "Email")
    cells = project_row_to_cells(_row(), headers=headers, mapping=mapping)

    assert cells == ["555-0192", "Maria Lopez", "maria@example.com"]


def test_project_auto_stamps_date_captured_and_source_columns() -> None:
    """Server-stamped meta-columns get filled even though they're not in the mapping."""
    mapping = ColumnMapping(
        fields={
            LeadField.NAME: "Name",
            LeadField.PHONE: None,
            LeadField.EMAIL: None,
            LeadField.AREA: None,
            LeadField.BUDGET: None,
            LeadField.FOLLOW_UP: None,
            LeadField.NOTES: None,
        },
        unmapped_headers=("Date Captured", "Source"),
    )
    headers = ("Name", "Date Captured", "Source")
    cells = project_row_to_cells(_row(), headers=headers, mapping=mapping)

    assert cells[0] == "Maria Lopez"
    # Spec §11 friendly format: no leading zeros on day or hour.
    assert cells[1] == "May 9, 2:30 PM"
    assert cells[2] == "text"


def test_project_leaves_unmapped_columns_empty() -> None:
    """A column we don't recognise should not be overwritten — empty cell."""
    mapping = ColumnMapping(
        fields={field: None for field in LeadField} | {LeadField.NAME: "Name"},
        unmapped_headers=("Internal ID",),
    )
    headers = ("Name", "Internal ID", "Notes column we ignore")
    cells = project_row_to_cells(_row(), headers=headers, mapping=mapping)

    assert cells[0] == "Maria Lopez"
    assert cells[1] == ""
    assert cells[2] == ""


def test_project_handles_missing_field_values_as_empty_string() -> None:
    """A SheetRow field with `None` value lands as an empty cell, not a literal None."""
    mapping = ColumnMapping(
        fields={
            LeadField.NAME: "Name",
            LeadField.PHONE: "Phone",
            LeadField.EMAIL: None,
            LeadField.AREA: None,
            LeadField.BUDGET: None,
            LeadField.FOLLOW_UP: None,
            LeadField.NOTES: None,
        },
        unmapped_headers=(),
    )
    headers = ("Name", "Phone")
    cells = project_row_to_cells(
        _row(name=None, phone="555-0192"),
        headers=headers,
        mapping=mapping,
    )

    assert cells == ["", "555-0192"]


def test_project_is_case_insensitive_for_header_lookups() -> None:
    """Mapping pinned 'Phone' but live sheet renames to 'PHONE' — still works."""
    mapping = ColumnMapping(
        fields={
            LeadField.NAME: "Name",
            LeadField.PHONE: "Phone",
            LeadField.EMAIL: None,
            LeadField.AREA: None,
            LeadField.BUDGET: None,
            LeadField.FOLLOW_UP: None,
            LeadField.NOTES: None,
        },
        unmapped_headers=(),
    )
    headers = ("name", "PHONE")
    cells = project_row_to_cells(_row(), headers=headers, mapping=mapping)

    assert cells == ["Maria Lopez", "555-0192"]


# --- format_captured_at ---------------------------------------------------
#
# Spec §11 "May 9, 2:30 PM" — no leading zeros on day or hour, AM/PM
# in caps with a space before. Boundary cases pinned because each one
# is a footgun in a different way (12-hour wrap, single-digit day,
# single-digit hour).


def test_format_captured_at_canonical() -> None:
    assert format_captured_at(datetime(2026, 5, 9, 14, 30, tzinfo=UTC)) == "May 9, 2:30 PM"


def test_format_captured_at_midnight_renders_as_12_am() -> None:
    """Hour 0 must render as 12 AM, not 0 AM."""
    assert format_captured_at(datetime(2026, 5, 1, 0, 5, tzinfo=UTC)) == "May 1, 12:05 AM"


def test_format_captured_at_noon_renders_as_12_pm() -> None:
    """Hour 12 must render as 12 PM, not 0 PM."""
    assert format_captured_at(datetime(2026, 5, 1, 12, 0, tzinfo=UTC)) == "May 1, 12:00 PM"


def test_format_captured_at_single_digit_hour_morning() -> None:
    """9 AM should not be 09 AM."""
    assert format_captured_at(datetime(2026, 5, 1, 9, 5, tzinfo=UTC)) == "May 1, 9:05 AM"


def test_format_captured_at_single_digit_day() -> None:
    """May 1 should not be May 01."""
    assert format_captured_at(datetime(2026, 5, 1, 14, 30, tzinfo=UTC)) == "May 1, 2:30 PM"


def test_format_captured_at_two_digit_day_two_digit_hour() -> None:
    """Confirm the canonical case still works when no zero-stripping is needed."""
    assert format_captured_at(datetime(2026, 5, 10, 22, 5, tzinfo=UTC)) == "May 10, 10:05 PM"


def test_format_captured_at_minute_keeps_leading_zero() -> None:
    """Minute MUST stay zero-padded — :05 not :5."""
    assert format_captured_at(datetime(2026, 5, 9, 14, 5, tzinfo=UTC)) == "May 9, 2:05 PM"


def test_format_captured_at_uses_dt_wallclock_not_utc() -> None:
    """The formatter respects whatever tz the datetime carries.

    A 2026-05-09 21:30 UTC moment, when handed in `America/Los_Angeles`,
    formats as the wall-clock 2:30 PM (PT) — the formatter does not
    re-interpret the zone, just reads the digits the datetime has.
    """
    utc_moment = datetime(2026, 5, 9, 21, 30, tzinfo=UTC)
    pt = utc_moment.astimezone(ZoneInfo("America/Los_Angeles"))
    assert format_captured_at(pt) == "May 9, 2:30 PM"


def test_format_captured_at_same_utc_moment_in_two_zones() -> None:
    """Pin that the same UTC moment lands as different wall-clock strings
    in different zones — the whole point of the §2 timezone fix."""
    utc_moment = datetime(2026, 5, 9, 21, 30, tzinfo=UTC)
    la = format_captured_at(utc_moment.astimezone(ZoneInfo("America/Los_Angeles")))
    ny = format_captured_at(utc_moment.astimezone(ZoneInfo("America/New_York")))
    assert la == "May 9, 2:30 PM"
    assert ny == "May 9, 5:30 PM"


# --- resolve_zone ---------------------------------------------------------


def test_resolve_zone_none_input() -> None:
    assert resolve_zone(None) is None


def test_resolve_zone_empty_string() -> None:
    assert resolve_zone("") is None


def test_resolve_zone_valid_iana() -> None:
    zone = resolve_zone("America/Los_Angeles")
    assert zone is not None
    assert zone == ZoneInfo("America/Los_Angeles")


def test_resolve_zone_unknown_iana() -> None:
    """Unknown zone names fall back cleanly to None — never raise."""
    assert resolve_zone("Mars/Olympus_Mons") is None


def test_resolve_zone_garbage_string() -> None:
    """Garbage that doesn't even look like a zone name falls back."""
    assert resolve_zone("not a real zone") is None
    assert resolve_zone("../etc/passwd") is None
