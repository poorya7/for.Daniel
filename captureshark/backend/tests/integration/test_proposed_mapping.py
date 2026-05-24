"""End-to-end test for `GET /api/v1/sheets/proposed-mapping`.

Same dep-override pattern as `test_sheets.py`: swap the real
`UserMappingService` for a stub that returns canned outcomes. We're
verifying:

  * Auth required — unauthenticated requests get 401.
  * Each `kind` (`has_headers` / `empty` / `looks_like_data`) round-trips
    cleanly through the DTO.
  * Orchestrator errors (no connection, lost session) map to the
    documented status codes with plain-English copy.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from captureshark.api.deps import (
    get_required_signed_in_user,
    get_user_mapping_service,
)
from captureshark.domain.auth import Session, SignedInUser, User
from captureshark.domain.column_mapping import (
    ColumnMapping,
    LeadField,
    MappingProposal,
    MappingProposalKind,
)
from captureshark.domain.sheets import (
    SheetsErrorKind,
    SheetWriteError,
    UserMappingOutcome,
    UserSaveError,
    UserSaveErrorKind,
)
from captureshark.main import app


class _StubMappingService:
    """Stand-in for `UserMappingService` that returns a pre-set outcome."""

    def __init__(self, outcome: UserMappingOutcome) -> None:
        self._outcome = outcome
        self.calls: list[int] = []

    async def propose_for_user(self, *, user_id: int) -> UserMappingOutcome:
        self.calls.append(user_id)
        return self._outcome


_USER = User(
    id=42,
    google_user_id="g-42",
    email="broker@example.com",
    name="Broker",
    picture_url=None,
)
_SESSION = Session(
    id="sess-abc",
    user_id=_USER.id,
    created_at=datetime(2026, 1, 1, tzinfo=UTC),
    last_seen_at=datetime(2026, 1, 1, tzinfo=UTC),
    user_agent=None,
    ip_address=None,
)
_SIGNED_IN = SignedInUser(
    user=_USER, session=_SESSION, granted_scopes=frozenset()
)


@pytest.fixture
def install_overrides() -> Iterator[None]:
    """Installs auth + service stubs for the duration of one test."""
    yield
    app.dependency_overrides.clear()


def _install_signed_in() -> None:
    app.dependency_overrides[get_required_signed_in_user] = lambda: _SIGNED_IN


def _install_service(outcome: UserMappingOutcome) -> _StubMappingService:
    stub = _StubMappingService(outcome)
    app.dependency_overrides[get_user_mapping_service] = lambda: stub
    return stub


# --- Success shapes --------------------------------------------------------


def test_has_headers_round_trip(install_overrides: None) -> None:
    del install_overrides
    _install_signed_in()
    proposal = MappingProposal(
        kind=MappingProposalKind.HAS_HEADERS,
        headers=("Lead Name", "Tel", "Email"),
        mapping=ColumnMapping(
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
        ),
    )
    _install_service(("ok", proposal))
    client = TestClient(app)

    response = client.get("/api/v1/sheets/proposed-mapping")

    assert response.status_code == 200
    body = response.json()
    assert body["proposal"]["kind"] == "has_headers"
    assert body["proposal"]["headers"] == ["Lead Name", "Tel", "Email"]
    assert body["proposal"]["mapping"]["fields"]["name"] == "Lead Name"
    assert body["proposal"]["mapping"]["fields"]["phone"] == "Tel"
    assert body["proposal"]["mapping"]["fields"]["area"] is None
    assert body["proposal"]["mapping"]["unmapped_headers"] == []


def test_empty_proposal_has_null_mapping(install_overrides: None) -> None:
    del install_overrides
    _install_signed_in()
    proposal = MappingProposal(
        kind=MappingProposalKind.EMPTY, headers=(), mapping=None
    )
    _install_service(("ok", proposal))
    client = TestClient(app)

    response = client.get("/api/v1/sheets/proposed-mapping")

    assert response.status_code == 200
    body = response.json()
    assert body["proposal"]["kind"] == "empty"
    assert body["proposal"]["headers"] == []
    assert body["proposal"]["mapping"] is None


def test_looks_like_data_proposal_echoes_row(install_overrides: None) -> None:
    del install_overrides
    _install_signed_in()
    proposal = MappingProposal(
        kind=MappingProposalKind.LOOKS_LIKE_DATA,
        headers=("Maria Lopez", "555-0192"),
        mapping=None,
    )
    _install_service(("ok", proposal))
    client = TestClient(app)

    response = client.get("/api/v1/sheets/proposed-mapping")

    assert response.status_code == 200
    body = response.json()
    assert body["proposal"]["kind"] == "looks_like_data"
    assert body["proposal"]["headers"] == ["Maria Lopez", "555-0192"]
    assert body["proposal"]["mapping"] is None


# --- Error shapes ----------------------------------------------------------


def test_no_connection_returns_409(install_overrides: None) -> None:
    del install_overrides
    _install_signed_in()
    err = UserSaveError(
        kind=UserSaveErrorKind.NO_CONNECTION, detail="no sheet picked"
    )
    _install_service(("orchestrator_error", err))
    client = TestClient(app)

    response = client.get("/api/v1/sheets/proposed-mapping")

    assert response.status_code == 409
    body = response.json()
    assert body["error"]["code"] == "no_sheet_connected"


def test_read_permission_denied_returns_403(install_overrides: None) -> None:
    del install_overrides
    _install_signed_in()
    err = SheetWriteError(
        kind=SheetsErrorKind.PERMISSION_DENIED, detail="forbidden"
    )
    _install_service(("read_error", err))
    client = TestClient(app)

    response = client.get("/api/v1/sheets/proposed-mapping")

    assert response.status_code == 403
    body = response.json()
    assert body["error"]["code"] == "sheet_no_permission"


def test_unauthenticated_returns_401(install_overrides: None) -> None:
    del install_overrides
    # Don't install signed-in override — let the real dependency fire.
    # We DO need to install a service so the dep doesn't 503 first.
    _install_service(
        ("ok", MappingProposal(kind=MappingProposalKind.EMPTY, headers=(), mapping=None))
    )
    client = TestClient(app)

    response = client.get("/api/v1/sheets/proposed-mapping")

    # Auth dep raises 401 before our route runs.
    assert response.status_code == 401
