"""Unit tests for `services/auth_service.AuthService`.

The service orchestrates four ports — OAuth provider, user repo, token
store, session store. We exercise every branch using inline fakes that
record calls + ordering, so the tests pin not just *what* the service
calls but also *in what order*. The ordering matters: tokens save
before sessions create. Inverting that leaves a user with a session
but no tokens — looks signed-in, every Google call fails — which is
worse than the current "fail at session-create, no session" mode.

Encryption-at-rest is NOT tested here. The service hands plaintext
`OAuthTokens` to the token-store port; encryption is the adapter's
job. See `test_sqlite_token_store.py` for that layer.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest

from captureshark.domain.auth import (
    AuthErrorKind,
    OAuthExchangeOutcome,
    OAuthExchangeResult,
    OAuthRefreshOutcome,
    OAuthTokens,
    Session,
    User,
)
from captureshark.services.auth_service import AuthService

# --- Fakes ----------------------------------------------------------------
#
# Each fake records every call into a shared `Recorder` so tests can
# assert call order + counts. Real adapters/fixture state is overkill
# for a service-level test; recorded fakes are the right granularity.


@dataclass
class Recorder:
    """Shared call ledger for the four fakes — append-only timeline."""

    timeline: list[str] = field(default_factory=list)


class FakeOAuthProvider:
    """Records calls + returns canned outcomes per test."""

    def __init__(
        self,
        recorder: Recorder,
        *,
        exchange_outcome: OAuthExchangeOutcome | None = None,
        refresh_outcome: OAuthRefreshOutcome | None = None,
    ) -> None:
        self._rec = recorder
        self._exchange_outcome = exchange_outcome
        self._refresh_outcome = refresh_outcome
        self.last_state: str | None = None
        self.last_redirect_uri: str | None = None

    def build_authorization_url(self, *, state: str, redirect_uri: str) -> str:
        self.last_state = state
        self.last_redirect_uri = redirect_uri
        return f"https://accounts.google.com/oauth?state={state}"

    async def exchange_code(
        self, *, code: str, redirect_uri: str
    ) -> OAuthExchangeOutcome:
        self._rec.timeline.append("oauth.exchange_code")
        if self._exchange_outcome is None:
            raise AssertionError("FakeOAuthProvider.exchange_code called without canned outcome")
        return self._exchange_outcome

    async def refresh_access_token(
        self, *, refresh_token: str
    ) -> OAuthRefreshOutcome:
        self._rec.timeline.append("oauth.refresh_access_token")
        if self._refresh_outcome is None:
            raise AssertionError(
                "FakeOAuthProvider.refresh_access_token called without canned outcome"
            )
        return self._refresh_outcome


class FakeUserRepo:
    """Records calls; returns a canned `User` from upsert / get_by_id."""

    def __init__(
        self,
        recorder: Recorder,
        *,
        user: User | None = None,
        get_by_id_returns: User | None = None,
    ) -> None:
        self._rec = recorder
        self._user = user
        self._get_by_id_returns = get_by_id_returns
        self.upsert_calls: list[dict[str, str | None]] = []

    async def find_by_google_id(self, google_user_id: str) -> User | None:
        self._rec.timeline.append("users.find_by_google_id")
        return self._user

    async def get_by_id(self, user_id: int) -> User | None:
        self._rec.timeline.append("users.get_by_id")
        return self._get_by_id_returns

    async def upsert_from_google(
        self,
        *,
        google_user_id: str,
        email: str,
        name: str | None,
        picture_url: str | None,
    ) -> User:
        self._rec.timeline.append("users.upsert_from_google")
        self.upsert_calls.append(
            {
                "google_user_id": google_user_id,
                "email": email,
                "name": name,
                "picture_url": picture_url,
            }
        )
        if self._user is None:
            raise AssertionError("FakeUserRepo configured without a `user` to return")
        return self._user


class FakeTokenStore:
    """Records calls + the plaintext `OAuthTokens` it received on save."""

    def __init__(
        self,
        recorder: Recorder,
        *,
        get_returns: OAuthTokens | None = None,
    ) -> None:
        self._rec = recorder
        self._get_returns = get_returns
        self.saved: list[OAuthTokens] = []

    async def save_for_user(self, user_id: int, tokens: OAuthTokens) -> None:
        self._rec.timeline.append("tokens.save_for_user")
        self.saved.append(tokens)

    async def get_for_user(self, user_id: int) -> OAuthTokens | None:
        self._rec.timeline.append("tokens.get_for_user")
        return self._get_returns


class FakeSessionStore:
    """Records calls + canned session for create."""

    def __init__(
        self,
        recorder: Recorder,
        *,
        session: Session | None = None,
        get_returns: Session | None = None,
    ) -> None:
        self._rec = recorder
        self._session = session
        self._get_returns = get_returns
        self.deleted_ids: list[str] = []

    async def create(
        self,
        *,
        user_id: int,
        user_agent: str | None,
        ip_address: str | None,
    ) -> Session:
        self._rec.timeline.append("sessions.create")
        if self._session is None:
            raise AssertionError("FakeSessionStore configured without a `session` to return")
        return self._session

    async def get(self, session_id: str) -> Session | None:
        self._rec.timeline.append("sessions.get")
        return self._get_returns

    async def touch(self, session_id: str) -> None:
        self._rec.timeline.append("sessions.touch")

    async def delete(self, session_id: str) -> None:
        self._rec.timeline.append("sessions.delete")
        self.deleted_ids.append(session_id)


# --- Test fixtures --------------------------------------------------------


_USER = User(
    id=42,
    google_user_id="google-sub-abc",
    email="maria@example.com",
    name="Maria Lopez",
    picture_url="https://example.com/maria.jpg",
)
_SESSION = Session(
    id="sess-xyz",
    user_id=42,
    created_at=datetime(2026, 5, 10, 14, 30, tzinfo=UTC),
    last_seen_at=datetime(2026, 5, 10, 14, 30, tzinfo=UTC),
    user_agent="UA/1.0",
    ip_address="1.2.3.4",
)
_TOKENS = OAuthTokens(
    access_token="access-1",
    refresh_token="refresh-1",
    access_token_expires_at=datetime(2026, 5, 10, 15, 30, tzinfo=UTC),
    granted_scopes=frozenset({"openid", "email", "https://www.googleapis.com/auth/drive.file"}),
)


def _exchange_ok() -> OAuthExchangeOutcome:
    return (
        "ok",
        OAuthExchangeResult(
            google_user_id=_USER.google_user_id,
            email=_USER.email,
            name=_USER.name,
            picture_url=_USER.picture_url,
            access_token=_TOKENS.access_token,
            refresh_token=_TOKENS.refresh_token,
            access_token_expires_at=_TOKENS.access_token_expires_at,
            granted_scopes=_TOKENS.granted_scopes,
        ),
    )


def _build_service(
    *,
    exchange_outcome: OAuthExchangeOutcome | None = None,
    refresh_outcome: OAuthRefreshOutcome | None = None,
    user: User | None = _USER,
    get_user_by_id: User | None = _USER,
    session: Session | None = _SESSION,
    get_session: Session | None = _SESSION,
    get_tokens: OAuthTokens | None = _TOKENS,
    clock: Callable[[], datetime] | None = None,
) -> tuple[
    AuthService,
    Recorder,
    FakeOAuthProvider,
    FakeUserRepo,
    FakeTokenStore,
    FakeSessionStore,
]:
    rec = Recorder()
    oauth = FakeOAuthProvider(
        rec, exchange_outcome=exchange_outcome, refresh_outcome=refresh_outcome
    )
    users = FakeUserRepo(rec, user=user, get_by_id_returns=get_user_by_id)
    tokens = FakeTokenStore(rec, get_returns=get_tokens)
    sessions = FakeSessionStore(rec, session=session, get_returns=get_session)
    service = AuthService(
        oauth_provider=oauth,
        user_repo=users,
        token_store=tokens,
        session_store=sessions,
        clock=clock or (lambda: datetime(2026, 5, 10, 14, 30, tzinfo=UTC)),
    )
    return service, rec, oauth, users, tokens, sessions


# --- start_google_oauth ----------------------------------------------------


def test_start_google_oauth_returns_high_entropy_state() -> None:
    """State token must be ≥32 raw bytes worth of urlsafe-base64."""
    service, _, oauth, *_ = _build_service()
    result = service.start_google_oauth(redirect_uri="http://localhost/return")
    # 32 bytes of entropy = ~43 chars urlsafe-base64.
    assert len(result.state) >= 40
    # Round-trips through the provider verbatim.
    assert oauth.last_state == result.state
    assert oauth.last_redirect_uri == "http://localhost/return"


def test_start_google_oauth_produces_distinct_states_per_call() -> None:
    """Two consecutive calls produce different states (no accidental caching)."""
    service, _, *_ = _build_service()
    a = service.start_google_oauth(redirect_uri="http://localhost/return")
    b = service.start_google_oauth(redirect_uri="http://localhost/return")
    assert a.state != b.state


# --- handle_google_return: state mismatch ----------------------------------


@pytest.mark.asyncio
async def test_handle_google_return_state_mismatch_short_circuits() -> None:
    """URL state ≠ cookie state → INVALID_STATE; OAuth provider NOT called."""
    service, rec, *_ = _build_service(exchange_outcome=_exchange_ok())
    outcome = await service.handle_google_return(
        code="any",
        state_from_url="from-url",
        state_from_cookie="from-cookie",
        redirect_uri="http://localhost/return",
        user_agent=None,
        ip_address=None,
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.INVALID_STATE
    assert "oauth.exchange_code" not in rec.timeline


@pytest.mark.asyncio
async def test_handle_google_return_missing_cookie_state_short_circuits() -> None:
    """Cookie state is None → still INVALID_STATE (most common real failure)."""
    service, rec, *_ = _build_service(exchange_outcome=_exchange_ok())
    outcome = await service.handle_google_return(
        code="any",
        state_from_url="from-url",
        state_from_cookie=None,
        redirect_uri="http://localhost/return",
        user_agent=None,
        ip_address=None,
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.INVALID_STATE
    assert rec.timeline == []  # no downstream calls at all


# --- handle_google_return: OAuth error propagation ------------------------


@pytest.mark.asyncio
async def test_handle_google_return_oauth_error_skips_user_upsert() -> None:
    """OAuth provider returns error → propagated; user repo NOT touched."""
    from captureshark.domain.auth import AuthError

    service, rec, *_ = _build_service(
        exchange_outcome=("error", AuthError(kind=AuthErrorKind.OAUTH_FAILED, detail="nope"))
    )
    outcome = await service.handle_google_return(
        code="bad",
        state_from_url="state-1",
        state_from_cookie="state-1",
        redirect_uri="http://localhost/return",
        user_agent=None,
        ip_address=None,
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED
    assert "users.upsert_from_google" not in rec.timeline
    assert "tokens.save_for_user" not in rec.timeline
    assert "sessions.create" not in rec.timeline


# --- handle_google_return: success ordering -------------------------------


@pytest.mark.asyncio
async def test_handle_google_return_success_orders_calls_correctly() -> None:
    """Tokens MUST save before session creates.

    Inverting this order leaves a user with a session but no tokens —
    looks signed-in, every Google call fails. Worse than the current
    failure mode (session-create error → no session, retry sign-in).
    """
    service, rec, _, users, tokens, _ = _build_service(exchange_outcome=_exchange_ok())
    outcome = await service.handle_google_return(
        code="good",
        state_from_url="state-1",
        state_from_cookie="state-1",
        redirect_uri="http://localhost/return",
        user_agent="UA/1.0",
        ip_address="1.2.3.4",
    )
    assert outcome[0] == "ok"
    assert rec.timeline == [
        "oauth.exchange_code",
        "users.upsert_from_google",
        "tokens.save_for_user",
        "sessions.create",
    ]
    # User-upsert call carries the right Google identity.
    assert users.upsert_calls[0]["google_user_id"] == _USER.google_user_id
    # Token store received plaintext tokens; encryption is the adapter's job.
    assert tokens.saved[0].access_token == "access-1"
    assert tokens.saved[0].refresh_token == "refresh-1"


@pytest.mark.asyncio
async def test_handle_google_return_success_returns_signed_in_user() -> None:
    service, *_ = _build_service(exchange_outcome=_exchange_ok())
    outcome = await service.handle_google_return(
        code="good",
        state_from_url="state-1",
        state_from_cookie="state-1",
        redirect_uri="http://localhost/return",
        user_agent="UA/1.0",
        ip_address="1.2.3.4",
    )
    assert outcome[0] == "ok"
    signed_in = outcome[1]
    assert signed_in.user.id == _USER.id
    assert signed_in.session.id == _SESSION.id
    assert signed_in.has_drive_access is True


# --- get_user_for_session --------------------------------------------------


@pytest.mark.asyncio
async def test_get_user_for_session_missing_session_returns_not_found() -> None:
    """Session id with no row → SESSION_NOT_FOUND, no further calls."""
    service, rec, *_ = _build_service(get_session=None)
    outcome = await service.get_user_for_session("unknown-id")
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.SESSION_NOT_FOUND
    assert rec.timeline == ["sessions.get"]


@pytest.mark.asyncio
async def test_get_user_for_session_orphaned_user_deletes_session() -> None:
    """Session exists, user gone (CASCADE failed) → session deleted +
    SESSION_NOT_FOUND. Distinct branch from `missing_session`."""
    service, rec, _, _, _, sessions = _build_service(
        get_session=_SESSION,
        get_user_by_id=None,
    )
    outcome = await service.get_user_for_session(_SESSION.id)
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.SESSION_NOT_FOUND
    assert _SESSION.id in sessions.deleted_ids
    assert "sessions.touch" not in rec.timeline


@pytest.mark.asyncio
async def test_get_user_for_session_success_touches_session() -> None:
    """Happy path: returns SignedInUser, bumps last_seen_at via touch."""
    service, rec, *_ = _build_service()
    outcome = await service.get_user_for_session(_SESSION.id)
    assert outcome[0] == "ok"
    signed_in = outcome[1]
    assert signed_in.user.id == _USER.id
    assert signed_in.has_drive_access is True
    assert "sessions.touch" in rec.timeline


@pytest.mark.asyncio
async def test_get_user_for_session_missing_tokens_uses_empty_scopes() -> None:
    """Defensive branch: session + user exist but tokens row vanished →
    granted_scopes is the empty frozenset (no Drive access surfaced)."""
    service, *_ = _build_service(get_tokens=None)
    outcome = await service.get_user_for_session(_SESSION.id)
    assert outcome[0] == "ok"
    assert outcome[1].granted_scopes == frozenset()
    assert outcome[1].has_drive_access is False


# --- sign_out --------------------------------------------------------------


@pytest.mark.asyncio
async def test_sign_out_calls_session_delete() -> None:
    service, _, _, _, _, sessions = _build_service()
    await service.sign_out("sess-xyz")
    assert "sess-xyz" in sessions.deleted_ids


@pytest.mark.asyncio
async def test_sign_out_is_safe_to_rerun_on_unknown_id() -> None:
    """The doc promises idempotency on unknown ids — pin it."""
    service, _, _, _, _, sessions = _build_service()
    await service.sign_out("ghost-1")
    await service.sign_out("ghost-2")
    # Two delete calls, both succeeded without raising.
    assert sessions.deleted_ids == ["ghost-1", "ghost-2"]


# --- get_fresh_access_token ------------------------------------------------


@pytest.mark.asyncio
async def test_fresh_access_token_returns_only_access_not_refresh() -> None:
    """Apple-grade rule: refresh tokens never leave the server.

    The returned `FreshAccessToken` shape MUST NOT carry the refresh
    token. We pin via `dataclasses.fields` so a future field rename
    or addition that accidentally surfaces it fails this test loudly.
    """
    import dataclasses

    fresh_tokens = OAuthTokens(
        access_token="fresh-access",
        refresh_token="MUST-NOT-LEAK",
        access_token_expires_at=datetime(2026, 5, 10, 15, 30, tzinfo=UTC) + timedelta(hours=1),
        granted_scopes=_TOKENS.granted_scopes,
    )
    service, *_ = _build_service(
        get_tokens=fresh_tokens,  # well within expiry, no refresh needed
    )
    outcome = await service.get_fresh_access_token(_USER.id)
    assert outcome[0] == "ok"
    fresh = outcome[1]

    # Type-surface check: only `access_token` and `expires_at`.
    field_names = {f.name for f in dataclasses.fields(fresh)}
    assert field_names == {"access_token", "expires_at"}

    # Belt-and-braces runtime check: stringification doesn't accidentally
    # carry the refresh token (e.g., via __repr__ on a future field).
    assert "MUST-NOT-LEAK" not in repr(fresh)
    assert fresh.access_token == "fresh-access"
