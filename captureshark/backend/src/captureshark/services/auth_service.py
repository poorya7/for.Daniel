"""Auth service — orchestrates OAuth, user upsert, token store, session.

Sits above the four ports defined in `domain/auth.py` and below the
HTTP layer in `api/routes/auth.py`. Knows nothing about cookies, JSON,
or HTTP status codes — those are the API layer's problem. Knows nothing
about JWTs, JWKS, encryption, or SQL — those are the adapters' problem.

What this service owns end-to-end:

  * The **state token** generated for each sign-in attempt. The API
    layer carries it via a signed cookie; the service generates it,
    stores it nowhere, and verifies it on the callback by comparing
    URL-state to cookie-state. Server-side state storage is deliberately
    avoided — the cookie + signature is enough to prove "this callback
    belongs to this sign-in attempt".
  * The **idempotent upsert** of the Google identity into our `users`
    table on every successful callback. A returning user does not
    create a duplicate row; their profile fields refresh in place.
  * The **token persistence** path: tokens go through the encrypted
    store; the service never reads them itself.
  * The **session creation**: every successful sign-in mints a fresh
    session row whose id the API layer hands back via the HttpOnly
    cookie.

What's *not* here yet:

  * Silent access-token refresh ahead of Google API calls. That'll
    land alongside the Picker / Sheets auth-aware adapter (step 4d).
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final, Literal

from captureshark.domain.auth import (
    AuthError,
    AuthErrorKind,
    AuthStartResult,
    FreshAccessToken,
    FreshTokenOutcome,
    OAuthProviderPort,
    OAuthTokens,
    SessionLookupOutcome,
    SessionStorePort,
    SignedInUser,
    SignInOutcome,
    TokenStorePort,
    UserRepoPort,
)
from captureshark.services._token_freshness import get_fresh_tokens


# 32 bytes urlsafe-base64 (~43 chars) — well above CSRF-grade entropy.
_STATE_TOKEN_BYTES: Final = 32


class AuthService:
    """Orchestrates the full OAuth + session lifecycle.

    Constructor takes the four ports as dependencies. `api/deps.py`
    wires real adapters; tests inject fakes that record calls and
    return canned outcomes.
    """

    def __init__(
        self,
        *,
        oauth_provider: OAuthProviderPort,
        user_repo: UserRepoPort,
        token_store: TokenStorePort,
        session_store: SessionStorePort,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._oauth = oauth_provider
        self._users = user_repo
        self._tokens = token_store
        self._sessions = session_store
        self._clock = clock

    # ----- Sign-in start --------------------------------------------------

    def start_google_oauth(self, *, redirect_uri: str) -> AuthStartResult:
        """Generate a fresh state token + the Google authorize URL.

        Synchronous: this just composes a URL and rolls a random token.
        The API layer is responsible for shipping the state to the
        browser as a short-lived signed cookie before the redirect.
        """
        state = secrets.token_urlsafe(_STATE_TOKEN_BYTES)
        redirect_url = self._oauth.build_authorization_url(
            state=state, redirect_uri=redirect_uri
        )
        return AuthStartResult(redirect_url=redirect_url, state=state)

    # ----- Sign-in return -------------------------------------------------

    async def handle_google_return(
        self,
        *,
        code: str,
        state_from_url: str,
        state_from_cookie: str | None,
        redirect_uri: str,
        user_agent: str | None,
        ip_address: str | None,
    ) -> SignInOutcome:
        """Complete the OAuth round-trip and return a fresh session.

        Steps, in order — the first one that fails short-circuits:

        1. State match. Constant-time comparison of URL state to the
           cookie value the API layer passes through. A mismatch means
           CSRF, replay, expired cookie, or new tab — all surfaced as
           `INVALID_STATE`.
        2. Code exchange (delegated to `OAuthProviderPort`).
        3. User upsert (delegated to `UserRepoPort`).
        4. Token persistence (delegated to `TokenStorePort`).
        5. Session creation (delegated to `SessionStorePort`).
        """
        if not _states_match(state_from_url, state_from_cookie):
            return _err(
                AuthErrorKind.INVALID_STATE,
                "OAuth state mismatch — likely a stale or replayed callback.",
            )

        exchange_outcome = await self._oauth.exchange_code(
            code=code, redirect_uri=redirect_uri
        )
        if exchange_outcome[0] == "error":
            return exchange_outcome
        result = exchange_outcome[1]

        user = await self._users.upsert_from_google(
            google_user_id=result.google_user_id,
            email=result.email,
            name=result.name,
            picture_url=result.picture_url,
        )

        await self._tokens.save_for_user(
            user.id,
            OAuthTokens(
                access_token=result.access_token,
                refresh_token=result.refresh_token,
                access_token_expires_at=result.access_token_expires_at,
                granted_scopes=result.granted_scopes,
            ),
        )

        session = await self._sessions.create(
            user_id=user.id,
            user_agent=user_agent,
            ip_address=ip_address,
        )
        return (
            "ok",
            SignedInUser(
                session=session, user=user, granted_scopes=result.granted_scopes
            ),
        )

    # ----- Authenticated request path -------------------------------------

    async def get_user_for_session(self, session_id: str) -> SessionLookupOutcome:
        """Resolve a session id to its user, bumping `last_seen_at`.

        Returns `SESSION_NOT_FOUND` if the cookie was tampered with,
        the session was revoked, or the user row is gone. The API
        layer maps that to a 401 + a `Set-Cookie: ...; Max-Age=0` so
        the browser drops the stale cookie cleanly.
        """
        session = await self._sessions.get(session_id)
        if session is None:
            return _err(
                AuthErrorKind.SESSION_NOT_FOUND,
                "No matching session row.",
            )
        user = await self._users.get_by_id(session.user_id)
        if user is None:
            # Session row outlived its user (the CASCADE FK should
            # prevent this — defensive belt-and-braces). Treat as
            # revoked so the cookie gets cleared cleanly.
            await self._sessions.delete(session_id)
            return _err(
                AuthErrorKind.SESSION_NOT_FOUND,
                "Session pointed at a missing user.",
            )
        # Fetch scopes so the API layer can answer `has_drive_access`
        # without an extra round-trip. Empty scopes if the row was
        # somehow lost (defensive — shouldn't happen post-callback).
        tokens = await self._tokens.get_for_user(user.id)
        granted_scopes = tokens.granted_scopes if tokens is not None else frozenset()
        await self._sessions.touch(session_id)
        return (
            "ok",
            SignedInUser(session=session, user=user, granted_scopes=granted_scopes),
        )

    async def sign_out(self, session_id: str) -> None:
        """Revoke the session — idempotent, never raises on unknown id."""
        await self._sessions.delete(session_id)

    # ----- Fresh access token (for the JS Picker SDK) ---------------------

    async def get_fresh_access_token(self, user_id: int) -> FreshTokenOutcome:
        """Return a non-expired access token for the user, refreshing if needed.

        The Picker SDK runs in the browser and needs an access token in
        memory. The frontend hits `/auth/picker-token`; this method
        loads the encrypted tokens, refreshes against Google if expiry
        is within the buffer, and hands back just the access-token
        slice — never the refresh token. Apple-grade rule: refresh
        tokens never leave the server.
        """
        outcome = await get_fresh_tokens(
            user_id=user_id,
            tokens_store=self._tokens,
            oauth=self._oauth,
            now=self._clock,
        )
        if outcome[0] == "error":
            return outcome
        tokens = outcome[1]
        return (
            "ok",
            FreshAccessToken(
                access_token=tokens.access_token,
                expires_at=tokens.access_token_expires_at,
            ),
        )


# --- Helpers ---------------------------------------------------------------


def _err(
    kind: AuthErrorKind, detail: str
) -> tuple[Literal["error"], AuthError]:
    """Compact error tuple — preserves the `Literal["error"]` discriminator
    so mypy narrows correctly at call sites in `SignInOutcome` /
    `SessionLookupOutcome`-typed methods."""
    return ("error", AuthError(kind=kind, detail=detail))


def _states_match(url_state: str, cookie_state: str | None) -> bool:
    """Constant-time equality check that tolerates a missing cookie.

    `secrets.compare_digest` short-circuits length mismatches before the
    byte-by-byte loop, but does so in constant time *for the lengths
    that match*. Refusing the empty-cookie case explicitly is clearer
    than letting it fall through to a length mismatch.
    """
    if not url_state or not cookie_state:
        return False
    return secrets.compare_digest(url_state, cookie_state)
