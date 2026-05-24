"""Row-formatting helpers shared by the Sheets adapters.

Both the service-account adapter (`google_sheets_repo.py`) and the
user-OAuth adapter (`user_oauth_sheets_writer.py`) need to project a
`SheetRow` to the same list of cell strings — same column order, same
friendly date format. Sharing the helper keeps them in lockstep
without one quietly drifting from the other.

The friendly-date helper itself lives in `domain/column_mapping.py`
(`format_captured_at`) — same single source the mapped-column
projection uses, so there's no chance of two formatters drifting
out of step on a future spec change.

Marked private (leading `_` in the filename) to make the
not-public-API status obvious to anyone grepping `adapters/`.
"""

from __future__ import annotations

from typing import Final

from captureshark.domain.column_mapping import format_captured_at
from captureshark.domain.sheets import SheetRow

# v1 default column order. Matches the headers the user sets up in
# their dev test sheet (and what we'll auto-create on first connect
# once step 5 lands header detection / mapping). Don't reorder without
# updating the docs in `01_sheets-dev-setup.md`.
VALUE_RANGE_COLS: Final = (
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
    "Date Captured",
    "Source",
)


def row_to_cells(row: SheetRow) -> list[str]:
    """Render a `SheetRow` as the list of cell strings the API will write.

    Order MUST match `VALUE_RANGE_COLS`. Empty fields become "" since
    Sheets treats null and empty-string the same for our purposes.
    """
    return [
        row.name or "",
        row.phone or "",
        row.email or "",
        row.has_agent or "",
        row.intent or "",
        row.timeline or "",
        row.financing_status or "",
        row.budget or "",
        row.area or "",
        row.follow_up or "",
        row.notes or "",
        format_captured_at(row.captured_at),
        row.source,
    ]
