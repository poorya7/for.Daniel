"""End-to-end test for the sheets append endpoint.

Uses FastAPI's dependency-override hook to swap the production sheets
service for an in-memory fake. No real Google API calls are made; we're
verifying:

  * Request body validates and rejects extras.
  * A successful save round-trips into the documented response shape.
  * Domain error kinds map to the right HTTP statuses + plain-English copy.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from captureshark.api.deps import get_sheets_service
from captureshark.domain.sheets import (
    SheetsErrorKind,
    SheetTarget,
    SheetWriteError,
    SheetWriteOutcome,
    SheetWriteSuccess,
)
from captureshark.main import app


class _StubSheetsService:
    """Accepts the same kwargs as `SheetsService.save_lead`, returns a
    pre-set outcome. Implements the structural shape FastAPI sees."""

    def __init__(self, outcome: SheetWriteOutcome) -> None:
        self._outcome = outcome
        self.calls: list[dict[str, str | None]] = []

    def save_lead(self, **kwargs: str | None) -> SheetWriteOutcome:
        self.calls.append(dict(kwargs))
        return self._outcome


@pytest.fixture
def stub_service() -> Iterator[_StubSheetsService]:
    """Each test installs its own stub via `stub_service.set(...)`."""

    holder: dict[str, _StubSheetsService] = {}

    def install(outcome: SheetWriteOutcome) -> _StubSheetsService:
        stub = _StubSheetsService(outcome)
        holder["stub"] = stub
        app.dependency_overrides[get_sheets_service] = lambda: stub
        return stub

    # Hide the install fn on the fixture for tests that need to swap mid-test.
    yield install  # type: ignore[misc]
    app.dependency_overrides.clear()


_TARGET = SheetTarget(
    spreadsheet_id="abc123",
    worksheet_title="Sheet1",
    display_name="Open House Leads",
)


def test_save_returns_target(stub_service) -> None:  # type: ignore[no-untyped-def]
    stub = stub_service(("ok", SheetWriteSuccess(target=_TARGET)))
    client = TestClient(app)

    response = client.post(
        "/api/v1/sheets/append",
        json={
            "name": "Maria Lopez",
            "phone": "555-0192",
            "area": "Maple St",
            "source": "text",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["target"]["display_name"] == "Open House Leads"
    assert body["target"]["spreadsheet_id"] == "abc123"
    assert len(stub.calls) == 1
    assert stub.calls[0]["name"] == "Maria Lopez"
    assert stub.calls[0]["source"] == "text"
    assert stub.calls[0]["email"] is None


def test_permission_denied_maps_to_403_with_friendly_copy(stub_service) -> None:  # type: ignore[no-untyped-def]
    err = SheetWriteError(kind=SheetsErrorKind.PERMISSION_DENIED, detail="nope")
    stub_service(("error", err))
    client = TestClient(app)

    response = client.post(
        "/api/v1/sheets/append",
        json={"name": "Jane", "source": "text"},
    )

    assert response.status_code == 403
    body = response.json()
    assert body["error"]["code"] == "sheet_no_permission"
    assert "permission" in body["error"]["message"].lower()


def test_extras_in_body_rejected(stub_service) -> None:  # type: ignore[no-untyped-def]
    stub_service(("ok", SheetWriteSuccess(target=_TARGET)))
    client = TestClient(app)
    response = client.post(
        "/api/v1/sheets/append",
        json={"name": "Jane", "source": "text", "bogus": "field"},
    )
    assert response.status_code == 422
