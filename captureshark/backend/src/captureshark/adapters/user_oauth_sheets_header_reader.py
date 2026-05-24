"""User-OAuth Google Sheets header reader — implements `SheetHeaderReaderPort`.

Sibling of `user_oauth_sheets_writer.py`. Same auth model (per-call
access token, no SDK ceremony), same error-mapping table (shared via
`adapters/_sheets_status_map.py` since §5); only the HTTP method, URL
shape, and response parsing differ.

We read the first row via `spreadsheets.values.get` with the range
`<tab>!1:1` — that's the entire row 1 across whatever columns the
sheet has, so we don't need to guess column count up front. Google
returns either:

  * `{"values": [["Name", "Phone", ...]]}` — at least one cell with text
  * `{}`                                    — row 1 has no data

Empty-row → empty tuple of headers. The `propose_mapping` domain
function classifies that as `EMPTY` and the frontend surfaces *"Want
us to set up the headers for you?"* per spec §4.

Failure-mode contract per `SheetHeaderReaderPort`: same as the writer,
plus the success-shape itself models *"row 1 was empty"* (an empty
tuple) rather than treating it as an error. Empty is a valid state,
not a fault.
"""

from __future__ import annotations

import logging
from typing import Any, Final
from urllib.parse import quote

import httpx

from captureshark.adapters._sheets_status_map import map_error_response
from captureshark.domain.sheets import (
    SheetHeaderReaderPort,
    SheetHeaderReadOutcome,
    SheetHeaderReadSuccess,
    SheetsErrorKind,
    SheetTarget,
    SheetWriteError,
)

logger = logging.getLogger(__name__)

_SHEETS_API_BASE: Final = "https://sheets.googleapis.com/v4"
_DEFAULT_TIMEOUT_SECONDS: Final = 15.0


class UserOAuthSheetsHeaderReader(SheetHeaderReaderPort):
    """Async user-OAuth implementation of header reading.

    Constructor injection on `httpx.AsyncClient` so tests can wire a
    `MockTransport`. Production wiring (`api/deps.py`) shares the same
    long-lived client as the writer + OAuth provider — keeps the
    connection pool warm across all three.
    """

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        self._http = http_client or httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_SECONDS)

    async def read_headers(
        self,
        *,
        access_token: str,
        target: SheetTarget,
    ) -> SheetHeaderReadOutcome:
        # `<tab>!1:1` = "row 1 across all columns of <tab>". Google
        # returns just the cells that have values; trailing blanks are
        # truncated. That's fine — `propose_mapping` is robust to
        # variable-length header lists.
        encoded_range = quote(f"{target.worksheet_title}!1:1", safe="")
        url = (
            f"{_SHEETS_API_BASE}/spreadsheets/{quote(target.spreadsheet_id, safe='')}"
            f"/values/{encoded_range}"
        )

        try:
            response = await self._http.get(
                url,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/json",
                },
            )
        except httpx.TimeoutException:
            return _err(
                SheetsErrorKind.UPSTREAM_UNAVAILABLE, "Google Sheets timed out."
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "sheets header-read network error",
                extra={"exc_class": exc.__class__.__name__},
            )
            return _err(
                SheetsErrorKind.UPSTREAM_UNAVAILABLE, "Couldn't reach Google Sheets."
            )

        if response.status_code != 200:
            err, reason = map_error_response(response)
            logger.warning(
                "sheets header-read rejected",
                extra={
                    "status": response.status_code,
                    "google_reason": reason,
                    "kind": err.kind.value,
                },
            )
            return ("error", err)

        return ("ok", _parse_headers(response.json()))


def _parse_headers(payload: dict[str, Any]) -> SheetHeaderReadSuccess:
    """Pull the first row from a `values.get` payload.

    Google returns `{"range": ..., "majorDimension": "ROWS", "values":
    [[...]]}` when there's data, or `{"range": ..., "majorDimension":
    "ROWS"}` (no `values` key) when the row is empty. We coerce the
    latter to an empty tuple — same shape, no special-case for callers.
    """
    rows = payload.get("values") or []
    if not rows:
        return SheetHeaderReadSuccess(headers=())
    first_row = rows[0]
    # Sheets returns whatever types are in the cells; coerce to str
    # because the proposer expects str. Numbers in row 1 stringify
    # naturally and still trigger the *"looks like data"* heuristic.
    return SheetHeaderReadSuccess(
        headers=tuple(str(cell) for cell in first_row),
    )


def _err(kind: SheetsErrorKind, detail: str) -> tuple[Any, SheetWriteError]:
    return ("error", SheetWriteError(kind=kind, detail=detail))
