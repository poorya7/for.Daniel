"""Shared HTTP-status → SheetsErrorKind mapping for the user-OAuth adapters.

Both `user_oauth_sheets_writer.py` and `user_oauth_sheets_header_reader.py`
need the same status-code translation. Before §5 each adapter had its
own private `_map_status` — same logic, two copies, ripe to drift. This
module is the single source.

Marked private (leading `_` in the filename) for the same reason as
`_sheets_row_format.py` — adapters are allowed to import sibling
private helpers, but downstream code (services, API, domain) must not.

Also handles parsing Google's structured error body for the
`error.reason` field, surfaced as a separate string the calling
adapter logs alongside the typed error. We never show this string to
end users — keep their copy calm and app-specific. The reason is for
support / on-call diagnostics.
"""

from __future__ import annotations

import httpx

from captureshark.domain.sheets import SheetsErrorKind, SheetWriteError


def map_error_response(
    response: httpx.Response,
) -> tuple[SheetWriteError, str | None]:
    """Map a non-200 Sheets response to (typed-error, google-reason).

    The reason string (when present) is structured detail from Google's
    error body — values like `permissionDenied`, `insufficientPermissions`,
    `domainPolicyDenied`. The calling adapter logs it as a structured
    field; this helper does NOT log because the per-module logger
    (`captureshark.adapters.user_oauth_sheets_writer` vs `…_header_reader`)
    matters for triage.

    Status mapping:
      * 401            → AUTH_EXPIRED      (token rejected, re-sign-in)
      * 403            → PERMISSION_DENIED (signed-in, not allowed)
      * 404 / 410      → NOT_FOUND         (sheet gone — Google returns
                                            410 when permanently deleted)
      * 429            → UPSTREAM_RATE_LIMITED
      * 5xx / other    → UPSTREAM_UNAVAILABLE
    """
    status = response.status_code
    reason = google_error_reason(response)

    if status == 401:
        return (
            SheetWriteError(
                kind=SheetsErrorKind.AUTH_EXPIRED,
                detail="Google rejected the saved sign-in. Sign in again.",
            ),
            reason,
        )
    if status == 403:
        return (
            SheetWriteError(
                kind=SheetsErrorKind.PERMISSION_DENIED,
                detail="No permission to access this sheet.",
            ),
            reason,
        )
    if status in (404, 410):
        return (
            SheetWriteError(
                kind=SheetsErrorKind.NOT_FOUND,
                detail="The sheet wasn't found — was it deleted or moved?",
            ),
            reason,
        )
    if status == 429:
        return (
            SheetWriteError(
                kind=SheetsErrorKind.UPSTREAM_RATE_LIMITED,
                detail="Google Sheets is rate-limiting us.",
            ),
            reason,
        )
    return (
        SheetWriteError(
            kind=SheetsErrorKind.UPSTREAM_UNAVAILABLE,
            detail=f"Google Sheets returned an unexpected error ({status}).",
        ),
        reason,
    )


def google_error_reason(response: httpx.Response) -> str | None:
    """Extract Google's structured `error.reason` (or fallback) from a response body.

    Google's Sheets API returns errors in this shape:

        {"error": {"code": 403, "message": "...", "errors": [...],
                   "status": "PERMISSION_DENIED",
                   "details": [{"@type": "...", "reason": "permissionDenied"}]}}

    We probe for the most-specific signal first (`details[].reason`),
    then fall back to `status`, then `message`. Returns `None` if none
    of those are present or the body isn't even JSON (e.g. a proxy
    served an HTML error page mid-outage).

    Order of fallbacks matters because a request that returns 403 with
    no reason field but a useful `status` ("DOMAIN_POLICY_DENIED",
    "INSUFFICIENT_SCOPE", etc.) is still triageable.
    """
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None

    error = payload.get("error")
    if not isinstance(error, dict):
        return None

    details = error.get("details")
    if isinstance(details, list):
        for item in details:
            if isinstance(item, dict) and isinstance(item.get("reason"), str):
                return item["reason"]

    if isinstance(error.get("status"), str):
        return error["status"]
    if isinstance(error.get("message"), str):
        return error["message"]
    return None
