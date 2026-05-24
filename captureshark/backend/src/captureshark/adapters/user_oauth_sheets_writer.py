"""User-OAuth Google Sheets writer — implements `UserSheetsWriterPort`.

Sibling of `google_sheets_repo.py` (the service-account dev path)
but credentials flow per-call instead of being held by the adapter:

  * **Service account** writes as a single non-human identity for the
    lifetime of the process (one cached `Resource`).
  * **User OAuth** writes as the signed-in user — each user has their
    own access token, tokens expire, the orchestrating service refreshes
    them. The adapter just takes whichever token is valid right now.

We talk to Google's REST API directly via `httpx` rather than going
through `google-api-python-client`. The SDK's `discovery.build` makes
a network round-trip per process to fetch the discovery document; for
a single endpoint (`spreadsheets.values.append`) that's a lot of
ceremony. A typed `httpx.AsyncClient.post` is faster, async-native,
and far easier to reason about under `mypy --strict`.

Failure-mode contract per `UserSheetsWriterPort`:

  * `httpx` network / timeout              → `UPSTREAM_UNAVAILABLE`
  * 401 (token rejected after our refresh) → `AUTH_EXPIRED`
  * 403                                    → `PERMISSION_DENIED`
  * 404 / 410                              → `NOT_FOUND`
  * 429                                    → `UPSTREAM_RATE_LIMITED`
  * 5xx / other                            → `UPSTREAM_UNAVAILABLE`

Token refresh is *not* this adapter's concern — it's the orchestrating
service's job. A 401 here means the service handed us a token Google
rejected (rare; usually means revocation since refresh, or a
deployment that lost its OAuth client).
"""

from __future__ import annotations

import logging
from typing import Any, Final
from urllib.parse import quote

import httpx

from captureshark.adapters._sheets_status_map import map_error_response
from captureshark.domain.sheets import (
    SheetsErrorKind,
    SheetTarget,
    SheetWriteError,
    SheetWriteOutcome,
    SheetWriteSuccess,
    UserSheetsWriterPort,
)

logger = logging.getLogger(__name__)

# Google Sheets v4 base. Pinning so a hijacked discovery document
# can't redirect; values are stable per Google's REST docs.
_SHEETS_API_BASE: Final = "https://sheets.googleapis.com/v4"
_DEFAULT_TIMEOUT_SECONDS: Final = 15.0


class UserOAuthSheetsWriter(UserSheetsWriterPort):
    """Async user-OAuth implementation."""

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        # Tests inject a `httpx.AsyncClient` backed by `MockTransport`.
        # In prod, `api/deps.py` hands in the same long-lived client
        # the OAuth provider uses — keeps the connection pool warm for
        # both endpoints.
        self._http = http_client or httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_SECONDS)

    async def append_cells(
        self,
        *,
        access_token: str,
        target: SheetTarget,
        cells: list[str],
    ) -> SheetWriteOutcome:
        # `range` is the worksheet title with `!A1` — Google finds the
        # first empty row at or below A1 within the table containing
        # A1, same semantics as the service-account path.
        encoded_tab = quote(f"{target.worksheet_title}!A1", safe="")
        url = (
            f"{_SHEETS_API_BASE}/spreadsheets/{quote(target.spreadsheet_id, safe='')}"
            f"/values/{encoded_tab}:append"
        )
        params = {
            "valueInputOption": "USER_ENTERED",
            "insertDataOption": "INSERT_ROWS",
        }
        body: dict[str, Any] = {"values": [cells]}

        try:
            response = await self._http.post(
                url,
                params=params,
                json=body,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/json",
                },
            )
        except httpx.TimeoutException:
            return _err(
                SheetsErrorKind.UPSTREAM_UNAVAILABLE,
                "Google Sheets timed out.",
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "sheets append network error",
                extra={"exc_class": exc.__class__.__name__},
            )
            return _err(
                SheetsErrorKind.UPSTREAM_UNAVAILABLE,
                "Couldn't reach Google Sheets.",
            )

        if response.status_code == 200:
            return ("ok", SheetWriteSuccess(target=target))
        err, reason = map_error_response(response)
        logger.warning(
            "sheets append rejected",
            extra={
                "status": response.status_code,
                "google_reason": reason,
                "kind": err.kind.value,
            },
        )
        return ("error", err)


def _err(kind: SheetsErrorKind, detail: str) -> tuple[Any, SheetWriteError]:
    return ("error", SheetWriteError(kind=kind, detail=detail))
