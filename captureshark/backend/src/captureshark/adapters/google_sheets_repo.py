"""Google Sheets adapter — service-account-backed implementation of `SheetsRepoPort`.

For step 3 of the build (write mechanics, no OAuth yet) we authenticate as a
**service account**: a non-human Google identity holding a private key file.
The user shares their dev test sheet with the service account's email, and
the adapter writes on its behalf.

This is intentionally distinct from the v1 user-flow auth (OAuth + the narrow
`spreadsheets.file` scope, landing in step 4). The same `SheetsRepoPort` will
be implemented again with OAuth credentials when that step lands; the rest of
the codebase doesn't care.

Design notes:
  * **Errors as data.** Recoverable upstream failures (404, 403, 429, network)
    become `SheetWriteError` values, never raised. Programmer errors still
    bubble.
  * **Column order is fixed for v1 dev.** Step 5 introduces header detection
    + mapping; until then the test sheet must use the v1 default header order
    (see `_VALUE_RANGE_COLS`).
  * **Friendly date formatting** at the boundary, per spec §11. Domain stores
    a raw `datetime`; the adapter formats it as e.g. "May 7, 2:30 PM" so the
    cell reads like a human wrote it.
"""

from __future__ import annotations

import logging
from typing import Any

from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError

from captureshark.adapters._sheets_row_format import row_to_cells
from captureshark.domain.sheets import (
    SheetRow,
    SheetsErrorKind,
    SheetTarget,
    SheetWriteError,
    SheetWriteOutcome,
    SheetWriteSuccess,
)

logger = logging.getLogger(__name__)


class GoogleSheetsRepo:
    """Service-account-backed sheets repo.

    Constructed with an authenticated `Resource` (the SDK's discovery client)
    so tests can swap in a fake. Production wiring lives in `api/deps.py`.
    """

    def __init__(self, sheets_resource: Resource) -> None:
        self._sheets = sheets_resource

    def append_row(self, target: SheetTarget, row: SheetRow) -> SheetWriteOutcome:
        values = [row_to_cells(row)]
        # The append range is "TabName!A1" — Google Sheets finds the first
        # empty row at or below A1 within the table that contains A1.
        range_a1 = f"{target.worksheet_title}!A1"

        try:
            self._sheets.spreadsheets().values().append(
                spreadsheetId=target.spreadsheet_id,
                range=range_a1,
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": values},
            ).execute()
        except HttpError as exc:
            return ("error", _map_http_error(exc))
        except (TimeoutError, ConnectionError) as exc:
            logger.warning(
                "sheets connection failure",
                extra={"exc_class": exc.__class__.__name__},
            )
            return (
                "error",
                SheetWriteError(
                    kind=SheetsErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="Couldn't reach Google Sheets.",
                ),
            )

        return ("ok", SheetWriteSuccess(target=target))


def _map_http_error(exc: HttpError) -> SheetWriteError:
    status = getattr(exc.resp, "status", None)
    reason = getattr(exc.resp, "reason", None)
    # Log EVERY HTTP error — known business-outcome 4xx (404/403/429)
    # and unexpected 5xx alike. Operator needs the receipt regardless
    # of whether we map it to a friendly user error or bucket it as
    # UNEXPECTED. PII never makes it here: Google's error body talks
    # about permissions / quota / sheet IDs, not row content.
    content_bytes = getattr(exc, "content", None)
    if isinstance(content_bytes, bytes | bytearray):
        google_body = bytes(content_bytes)[:500].decode("utf-8", errors="replace")
    else:
        google_body = None
    logger.warning(
        "sheets http error",
        extra={
            "status": status,
            "reason": reason,
            "exc_class": exc.__class__.__name__,
            "google_body": google_body,
        },
    )
    if status == 404:
        return SheetWriteError(
            kind=SheetsErrorKind.NOT_FOUND,
            detail="The sheet wasn't found.",
        )
    if status == 403:
        return SheetWriteError(
            kind=SheetsErrorKind.PERMISSION_DENIED,
            detail="No permission to write to this sheet.",
        )
    if status == 429:
        return SheetWriteError(
            kind=SheetsErrorKind.UPSTREAM_RATE_LIMITED,
            detail="Google Sheets is rate-limiting us.",
        )
    return SheetWriteError(
        kind=SheetsErrorKind.UPSTREAM_UNAVAILABLE,
        detail="Google Sheets returned an error.",
    )


def build_sheets_resource(service_account_path: str) -> Resource:
    """Construct an authenticated Sheets API client from a service-account key.

    Lives here (not in `deps.py`) so the auth wiring is colocated with the
    adapter that uses it. `deps.py` calls this once and caches the result.
    """
    # Imported lazily so the module imports stay cheap when the adapter
    # isn't used (e.g. unit tests with a fake repo).
    from google.oauth2 import service_account

    creds = service_account.Credentials.from_service_account_file(  # type: ignore[no-untyped-call]
        service_account_path,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    # `cache_discovery=False` skips writing a per-process discovery cache that
    # warns noisily on every startup.
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def fetch_sheet_display_name(sheets_resource: Resource, spreadsheet_id: str) -> str | None:
    """Fetch the user-visible title of the spreadsheet, or `None` on failure.

    Used at startup to populate `SheetTarget.display_name` so the
    confirmation card can read "Saved to <real sheet name> ✅" without the
    user having to configure the name twice.
    """
    try:
        response: dict[str, Any] = (
            sheets_resource.spreadsheets()
            .get(spreadsheetId=spreadsheet_id, fields="properties/title")
            .execute()
        )
    except HttpError as exc:
        logger.warning(
            "could not fetch sheet title",
            extra={
                "exc_class": exc.__class__.__name__,
                "status": getattr(exc.resp, "status", None),
            },
        )
        return None

    properties = response.get("properties")
    if not isinstance(properties, dict):
        return None
    title = properties.get("title")
    return title if isinstance(title, str) else None
