"""Unit tests for `services/_token_freshness.get_fresh_tokens`.

Refresh-and-persist is shared between the picker-token endpoint and
the per-user save flow; the helper is small but the branches matter:

  * Tokens still fresh → no refresh call, no DB write, return as-is.
  * Tokens near expiry → refresh, persist, return the new pair.
  * Refresh rotates the refresh token → persisted pair has the new
    refresh, not the old. (The Google docs say this happens "rarely
    but unpredictably" — pinning means we don't lose it on rotation.)
  * Refresh response omits scope → keep the prior grant set.
  * No tokens stored → AuthError(SESSION_NOT_FOUND).
  * Refresh upstream fails → error propagated.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from captureshark.domain.auth import (
    AuthError,
    AuthErrorKind,
    OAuthRefreshOutcome,
    OAuthRefreshResult,
    OAuthTokens,
)
from captureshark.services._token_freshness import REFRESH_BUFFER, get_fresh_tokens

# --- Fakes ----------------------------------------------------------------


class FakeTokenStore:
    """In-memory token store. Records every save."""

    def __init__(self, *, initial: OAuthTokens | None) -> None:
        self._tokens: OAuthTokens | None = initial
        self.saves: list[OAuthTokens] = []

    async def save_for_user(self, user_id: int, tokens: OAuthTokens) -> None:
        self._tokens = tokens
        self.saves.append(tokens)

    async def get_for_user(self, user_id: int) -> OAuthTokens | None:
        return self._tokens


class FakeOAuthProvider:
    """Returns a canned refresh outcome; tracks calls."""

    def __init__(self, *, refresh: OAuthRefreshOutcome) -> None:
        self._refresh = refresh
        self.refresh_calls: list[str] = []

    def build_authorization_url(self, *, state: str, redirect_uri: str) -> str:
        raise AssertionError("not used in these tests")

    async def exchange_code(self, *, code: str, redirect_uri: str):  # type: ignore[no-untyped-def]
        raise AssertionError("not used in these tests")

    async def refresh_access_token(
        self, *, refresh_token: str
    ) -> OAuthRefreshOutcome:
        self.refresh_calls.append(refresh_token)
        return self._refresh


# --- Test fixtures --------------------------------------------------------


_NOW = datetime(2026, 5, 10, 14, 30, tzinfo=UTC)


def _now_clock() -> datetime:
    return _NOW


def _fresh_tokens() -> OAuthTokens:
    """Tokens whose expiry is well past the refresh buffer — should
    skip the refresh entirely."""
    return OAuthTokens(
        access_token="A-1",
        refresh_token="R-1",
        access_token_expires_at=_NOW + timedelta(hours=1),
        granted_scopes=frozenset({"openid", "email"}),
    )


def _stale_tokens() -> OAuthTokens:
    """Tokens whose expiry is within the refresh buffer — should
    trigger a refresh on the next access."""
    return OAuthTokens(
        access_token="A-1",
        refresh_token="R-1",
        access_token_expires_at=_NOW + (REFRESH_BUFFER / 2),
        granted_scopes=frozenset({"openid", "email"}),
    )


# --- Tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_tokens_stored_returns_session_not_found() -> None:
    store = FakeTokenStore(initial=None)
    oauth = FakeOAuthProvider(
        refresh=("error", AuthError(kind=AuthErrorKind.OAUTH_FAILED, detail="unused"))
    )
    outcome = await get_fresh_tokens(
        user_id=1, tokens_store=store, oauth=oauth, now=_now_clock
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.SESSION_NOT_FOUND
    # No refresh call — we short-circuited cleanly.
    assert oauth.refresh_calls == []


@pytest.mark.asyncio
async def test_fresh_tokens_returned_as_is_without_refresh_call() -> None:
    store = FakeTokenStore(initial=_fresh_tokens())
    oauth = FakeOAuthProvider(
        refresh=("error", AuthError(kind=AuthErrorKind.OAUTH_FAILED, detail="unused"))
    )
    outcome = await get_fresh_tokens(
        user_id=1, tokens_store=store, oauth=oauth, now=_now_clock
    )
    assert outcome[0] == "ok"
    assert outcome[1].access_token == "A-1"
    assert oauth.refresh_calls == []
    assert store.saves == []  # no persist either


@pytest.mark.asyncio
async def test_stale_tokens_trigger_refresh_and_persist() -> None:
    """Within REFRESH_BUFFER → refresh called, new tokens persisted."""
    store = FakeTokenStore(initial=_stale_tokens())
    oauth = FakeOAuthProvider(
        refresh=(
            "ok",
            OAuthRefreshResult(
                access_token="A-2",
                access_token_expires_at=_NOW + timedelta(hours=1),
                granted_scopes=frozenset({"openid", "email"}),
                refresh_token=None,
            ),
        )
    )
    outcome = await get_fresh_tokens(
        user_id=1, tokens_store=store, oauth=oauth, now=_now_clock
    )
    assert outcome[0] == "ok"
    assert outcome[1].access_token == "A-2"
    assert oauth.refresh_calls == ["R-1"]
    assert len(store.saves) == 1
    assert store.saves[0].access_token == "A-2"


@pytest.mark.asyncio
async def test_rotated_refresh_token_is_persisted() -> None:
    """Refresh response with a new refresh_token → persisted pair has the new one.

    This is the engineer-04 catch — without it, a rotation would
    leave us writing back the old (now-revoked) refresh token, and
    the next refresh attempt would fail."""
    store = FakeTokenStore(initial=_stale_tokens())
    oauth = FakeOAuthProvider(
        refresh=(
            "ok",
            OAuthRefreshResult(
                access_token="A-2",
                access_token_expires_at=_NOW + timedelta(hours=1),
                granted_scopes=frozenset({"openid", "email"}),
                refresh_token="R-2-rotated",
            ),
        )
    )
    outcome = await get_fresh_tokens(
        user_id=1, tokens_store=store, oauth=oauth, now=_now_clock
    )
    assert outcome[0] == "ok"
    assert outcome[1].refresh_token == "R-2-rotated"
    # Persisted version also has the rotated refresh.
    assert store.saves[0].refresh_token == "R-2-rotated"


@pytest.mark.asyncio
async def test_non_rotated_refresh_keeps_existing_refresh_token() -> None:
    """Refresh response with `refresh_token=None` → carry the existing one through.

    Mirror image of the rotation test — important because
    Google omits the field on most refreshes; if we ever flipped
    the logic to write `None` we'd brick every user on next refresh."""
    store = FakeTokenStore(initial=_stale_tokens())
    oauth = FakeOAuthProvider(
        refresh=(
            "ok",
            OAuthRefreshResult(
                access_token="A-2",
                access_token_expires_at=_NOW + timedelta(hours=1),
                granted_scopes=frozenset({"openid", "email"}),
                refresh_token=None,
            ),
        )
    )
    outcome = await get_fresh_tokens(
        user_id=1, tokens_store=store, oauth=oauth, now=_now_clock
    )
    assert outcome[0] == "ok"
    assert outcome[1].refresh_token == "R-1"
    assert store.saves[0].refresh_token == "R-1"


@pytest.mark.asyncio
async def test_refresh_response_with_empty_scopes_keeps_prior_grant() -> None:
    """Refresh response that omits `scope` → carry the prior grant set."""
    store = FakeTokenStore(initial=_stale_tokens())
    oauth = FakeOAuthProvider(
        refresh=(
            "ok",
            OAuthRefreshResult(
                access_token="A-2",
                access_token_expires_at=_NOW + timedelta(hours=1),
                granted_scopes=frozenset(),  # Google omitted
                refresh_token=None,
            ),
        )
    )
    outcome = await get_fresh_tokens(
        user_id=1, tokens_store=store, oauth=oauth, now=_now_clock
    )
    assert outcome[0] == "ok"
    # The OG grant set is preserved.
    assert outcome[1].granted_scopes == frozenset({"openid", "email"})


@pytest.mark.asyncio
async def test_refresh_failure_propagates() -> None:
    """Refresh upstream returns error → propagated, no persist."""
    store = FakeTokenStore(initial=_stale_tokens())
    oauth = FakeOAuthProvider(
        refresh=(
            "error",
            AuthError(kind=AuthErrorKind.UPSTREAM_UNAVAILABLE, detail="network"),
        )
    )
    outcome = await get_fresh_tokens(
        user_id=1, tokens_store=store, oauth=oauth, now=_now_clock
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.UPSTREAM_UNAVAILABLE
    assert store.saves == []
