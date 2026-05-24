"""Unit tests for `adapters/_sheets_status_map`.

Pins the status → SheetsErrorKind mapping for every documented branch
plus the malformed-body fallbacks. The writer + reader both call
`map_error_response`, so a regression here breaks both adapters in
lockstep — that's the point of having a single helper.

The 401 vs 403 split is the load-bearing branch added in §5: token
expired → re-sign-in (`AUTH_EXPIRED`); signed-in but not allowed on
this sheet → permission UI (`PERMISSION_DENIED`). Conflating them
lands the broker on the wrong recovery path.
"""

from __future__ import annotations

import httpx

from captureshark.adapters._sheets_status_map import (
    google_error_reason,
    map_error_response,
)
from captureshark.domain.sheets import SheetsErrorKind

# --- map_error_response: status mapping -----------------------------------


def test_401_maps_to_auth_expired() -> None:
    """The §5 split — 401 means token dead, send the user to sign-in."""
    response = httpx.Response(401, json={"error": {"status": "UNAUTHENTICATED"}})
    err, reason = map_error_response(response)
    assert err.kind == SheetsErrorKind.AUTH_EXPIRED
    assert reason == "UNAUTHENTICATED"


def test_403_maps_to_permission_denied() -> None:
    """403 means signed-in but not allowed on this sheet — sharing UI."""
    response = httpx.Response(
        403,
        json={"error": {"status": "PERMISSION_DENIED",
                        "details": [{"reason": "permissionDenied"}]}},
    )
    err, reason = map_error_response(response)
    assert err.kind == SheetsErrorKind.PERMISSION_DENIED
    # `details[0].reason` wins over `status` when both are present.
    assert reason == "permissionDenied"


def test_404_maps_to_not_found() -> None:
    response = httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
    err, _ = map_error_response(response)
    assert err.kind == SheetsErrorKind.NOT_FOUND


def test_410_maps_to_not_found() -> None:
    """Google returns 410 when a sheet has been permanently removed —
    bucket with 404 so the user gets the same recovery copy."""
    response = httpx.Response(410, json={"error": {"status": "GONE"}})
    err, _ = map_error_response(response)
    assert err.kind == SheetsErrorKind.NOT_FOUND


def test_429_maps_to_rate_limited() -> None:
    response = httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED"}})
    err, _ = map_error_response(response)
    assert err.kind == SheetsErrorKind.UPSTREAM_RATE_LIMITED


def test_500_maps_to_upstream_unavailable() -> None:
    response = httpx.Response(500, json={"error": {"status": "INTERNAL"}})
    err, _ = map_error_response(response)
    assert err.kind == SheetsErrorKind.UPSTREAM_UNAVAILABLE


def test_503_maps_to_upstream_unavailable() -> None:
    response = httpx.Response(503)
    err, _ = map_error_response(response)
    assert err.kind == SheetsErrorKind.UPSTREAM_UNAVAILABLE


def test_unrecognised_status_falls_through_to_upstream_unavailable() -> None:
    """A future Google status we don't recognise → UNAVAILABLE, never throws."""
    response = httpx.Response(418, json={})  # I'm a teapot
    err, _ = map_error_response(response)
    assert err.kind == SheetsErrorKind.UPSTREAM_UNAVAILABLE
    # Detail string echoes the status so log triage can spot oddities.
    assert "418" in err.detail


# --- map_error_response: malformed body cases -----------------------------


def test_html_body_does_not_crash() -> None:
    """Some proxies return HTML mid-outage. We must map cleanly, not throw."""
    response = httpx.Response(
        503,
        content=b"<html>Service down</html>",
        headers={"content-type": "text/html"},
    )
    err, reason = map_error_response(response)
    assert err.kind == SheetsErrorKind.UPSTREAM_UNAVAILABLE
    assert reason is None


def test_json_array_body_does_not_crash() -> None:
    """Defensive: 4xx with `[]` (instead of dict) still maps to a kind."""
    response = httpx.Response(403, json=[1, 2, 3])
    err, reason = map_error_response(response)
    assert err.kind == SheetsErrorKind.PERMISSION_DENIED
    assert reason is None


def test_empty_body_returns_kind_with_none_reason() -> None:
    response = httpx.Response(401)
    err, reason = map_error_response(response)
    assert err.kind == SheetsErrorKind.AUTH_EXPIRED
    assert reason is None


# --- google_error_reason: extraction priority -----------------------------


def test_google_error_reason_prefers_details_reason() -> None:
    """The most-specific signal wins."""
    response = httpx.Response(
        403,
        json={
            "error": {
                "status": "PERMISSION_DENIED",
                "message": "human text",
                "details": [{"@type": "...", "reason": "domainPolicyDenied"}],
            }
        },
    )
    assert google_error_reason(response) == "domainPolicyDenied"


def test_google_error_reason_falls_back_to_status() -> None:
    response = httpx.Response(
        403, json={"error": {"status": "PERMISSION_DENIED", "message": "x"}}
    )
    assert google_error_reason(response) == "PERMISSION_DENIED"


def test_google_error_reason_falls_back_to_message() -> None:
    response = httpx.Response(403, json={"error": {"message": "Quota exhausted"}})
    assert google_error_reason(response) == "Quota exhausted"


def test_google_error_reason_returns_none_for_no_error_object() -> None:
    response = httpx.Response(200, json={"values": [["Name"]]})
    assert google_error_reason(response) is None


def test_google_error_reason_returns_none_for_html() -> None:
    response = httpx.Response(503, content=b"<html>nope</html>")
    assert google_error_reason(response) is None
