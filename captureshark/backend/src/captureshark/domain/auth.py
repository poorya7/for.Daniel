"""Auth domain — pure types describing identity, tokens, and sessions.

Mirrors the shape of `domain/extraction.py`: value objects, port Protocols,
and discriminated `Outcome` unions for errors-as-data. Nothing here imports
from `adapters/`, the database, or any framework — that's the whole point.

What lives here:

  * `User` — the authenticated identity, sourced from the Google `sub` claim.
  * `OAuthTokens` — the *plaintext* token shape services pass around. The
    on-disk encrypted form is an adapter concern (`OAuthTokenRow` in
    `adapters/orm.py`).
  * `Session` — a server-side session record; the cookie carries its `id`.
  * `OAuthExchangeResult` / `OAuthRefreshResult` — what the Google adapter
    returns when a `code` or `refresh_token` is redeemed.
  * `AuthError` — coarse error categories, mapped to user-facing copy in the
    API layer.
  * Port Protocols — `OAuthProviderPort`, `UserRepoPort`, `TokenStorePort`,
    `SessionStorePort` — the seams adapters implement and services depend on.

Design notes:

  * **Tokens flow as plaintext** through the domain. Services never see
    ciphertext. The token-store adapter is the *only* code that knows the
    Fernet key exists. Domain remains testable without crypto setup.
  * **State is owned by the API layer**, not the domain. CSRF protection
    via the `oauth_state` cookie lives in `api/routes/auth.py`; the domain
    just accepts an opaque `state: str` and trusts the caller to verify it.
"""

from __future__ import annotations

from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Final, Literal, Protocol, runtime_checkable


# --- Value objects ----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class User:
    """An authenticated CaptureShark user.

    `id` is our internal autoincrement primary key — short, stable across
    email changes. `google_user_id` is Google's `sub` claim, used to find
    the user on subsequent sign-ins. `email` is for display only — never
    used as an identity key (a Google account can change its primary
    email without becoming a different user).
    """

    id: int
    google_user_id: str
    email: str
    name: str | None
    picture_url: str | None


@dataclass(frozen=True, slots=True)
class OAuthTokens:
    """Plaintext OAuth tokens for one user, as services see them.

    `access_token` is short-lived (~1 hour) and used to call Google APIs.
    `refresh_token` is long-lived and used to mint new access tokens
    transparently when the access token expires. `granted_scopes` is the
    set the user actually consented to — may be a subset of what we
    asked for, since Google now lets users opt out of individual scopes
    on the consent screen.
    """

    access_token: str
    refresh_token: str
    access_token_expires_at: datetime
    granted_scopes: frozenset[str]


@dataclass(frozen=True, slots=True)
class Session:
    """A live browser session, addressed by its opaque `id`.

    `id` is what the HttpOnly cookie carries (signed). `last_seen_at` is
    bumped on every authenticated request so an admin "force sign-out
    inactive sessions" path can land cleanly later.
    """

    id: str
    user_id: int
    created_at: datetime
    last_seen_at: datetime
    user_agent: str | None
    ip_address: str | None


@dataclass(frozen=True, slots=True)
class OAuthExchangeResult:
    """Everything the OAuth adapter learns from redeeming an auth code.

    Combines the token-endpoint response with the decoded `id_token`
    claims, so callers don't need to round-trip through the userinfo
    endpoint to learn who just signed in.
    """

    google_user_id: str
    email: str
    name: str | None
    picture_url: str | None
    access_token: str
    refresh_token: str
    access_token_expires_at: datetime
    granted_scopes: frozenset[str]


@dataclass(frozen=True, slots=True)
class OAuthRefreshResult:
    """Result of refreshing an access token with a refresh token.

    Google occasionally rotates refresh tokens; when it does, the new
    one shows up in `refresh_token` and the caller is expected to
    persist it. When `refresh_token` is `None`, the prior refresh
    token is still valid and should be kept.
    """

    access_token: str
    access_token_expires_at: datetime
    granted_scopes: frozenset[str]
    refresh_token: str | None


# --- Errors -----------------------------------------------------------------


class AuthErrorKind(StrEnum):
    """Coarse categories the API layer maps to user-facing copy + HTTP status.

    Adding a kind = adding entries in the API error table. The domain
    stays free of HTTP / UI concerns; copy lives where it belongs.
    """

    MISSING_CONFIG = "missing_config"
    """Google client_id/secret or a session/encryption key is unset."""

    INVALID_STATE = "invalid_state"
    """OAuth `state` mismatch — CSRF, replay, or expired round-trip."""

    OAUTH_DENIED = "oauth_denied"
    """User clicked "Deny" on the Google consent screen."""

    OAUTH_FAILED = "oauth_failed"
    """Token endpoint refused the code (already used, expired, etc.)."""

    INVALID_ID_TOKEN = "invalid_id_token"
    """The `id_token` returned by Google failed signature/issuer validation."""

    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    """Google's OAuth/JWKS endpoints unreachable or 5xx."""

    SESSION_NOT_FOUND = "session_not_found"
    """Cookie presented a session id with no matching DB row."""

    UNEXPECTED = "unexpected"
    """Anything else — bug-shaped; logged but not leaked verbatim."""


@dataclass(frozen=True, slots=True)
class AuthError:
    """Errors-as-data for the auth domain. Routes turn these into HTTP."""

    kind: AuthErrorKind
    detail: str


@dataclass(frozen=True, slots=True)
class AuthStartResult:
    """What the auth service hands back when sign-in kicks off.

    `redirect_url` is the Google authorize URL the browser should
    navigate to. `state` is the random opaque value the API layer
    must round-trip via a short-lived signed cookie so the callback
    can prove the response belongs to *this* sign-in attempt.
    """

    redirect_url: str
    state: str


# The narrow Google-Sheets-via-Picker scope; if it's missing from the
# user's grant set after sign-in, the Picker / save path can't function
# and the frontend should surface a "permission was skipped" retry.
DRIVE_FILE_SCOPE: Final = "https://www.googleapis.com/auth/drive.file"


@dataclass(frozen=True, slots=True)
class SignedInUser:
    """The post-callback bundle: a fresh session + the user it identifies + their grants.

    `granted_scopes` is what the user *actually* consented to on Google's
    consent screen — may be a subset of what we asked for, since Google's
    granular-permissions UI lets users opt out per scope. Carrying it
    here lets `/auth/me` expose `has_drive_access` without a second DB
    hop in the API layer.
    """

    session: Session
    user: User
    granted_scopes: frozenset[str]

    @property
    def has_drive_access(self) -> bool:
        """True iff the user actually granted the narrow Drive/Sheets scope."""
        return DRIVE_FILE_SCOPE in self.granted_scopes


@dataclass(frozen=True, slots=True)
class FreshAccessToken:
    """A non-expired Google access token, ready to hand to a JS SDK or API call.

    `expires_at` is the absolute UTC moment the token stops working —
    callers can use it to decide whether to refresh on their side
    before the next Google call.
    """

    access_token: str
    expires_at: datetime


# --- Outcome unions ---------------------------------------------------------

OAuthExchangeOutcome = (
    tuple[Literal["ok"], OAuthExchangeResult] | tuple[Literal["error"], AuthError]
)
OAuthRefreshOutcome = (
    tuple[Literal["ok"], OAuthRefreshResult] | tuple[Literal["error"], AuthError]
)
SignInOutcome = (
    tuple[Literal["ok"], SignedInUser] | tuple[Literal["error"], AuthError]
)
SessionLookupOutcome = (
    tuple[Literal["ok"], SignedInUser] | tuple[Literal["error"], AuthError]
)
FreshTokenOutcome = (
    tuple[Literal["ok"], FreshAccessToken] | tuple[Literal["error"], AuthError]
)


# --- Ports ------------------------------------------------------------------


@runtime_checkable
class OAuthProviderPort(Protocol):
    """Adapter interface for the Google OAuth + ID-token surface.

    Implementations hide `httpx`, JWKS caching, and the OAuth library of
    the day. Tests inject a fake that returns canned outcomes — no
    network calls, no real token signing.
    """

    def build_authorization_url(self, *, state: str, redirect_uri: str) -> str:
        """Return the URL we redirect the browser to for sign-in.

        `state` is opaque from this port's POV — the API layer generates
        it and is responsible for verifying it on the callback. The
        provider just round-trips it via Google's `state` parameter.
        """
        ...

    async def exchange_code(
        self, *, code: str, redirect_uri: str
    ) -> OAuthExchangeOutcome:
        """Redeem the auth code Google returned for tokens + identity.

        Implementations MUST NOT raise on upstream failure (network,
        4xx, malformed response) — those become `("error", AuthError)`.
        Programmer errors (our own bugs) MAY still raise; the API layer
        catches them as `UNEXPECTED`.
        """
        ...

    async def refresh_access_token(
        self, *, refresh_token: str
    ) -> OAuthRefreshOutcome:
        """Mint a new access token using the long-lived refresh token."""
        ...


@runtime_checkable
class UserRepoPort(Protocol):
    """Find / upsert users by their Google identity or internal id."""

    async def find_by_google_id(self, google_user_id: str) -> User | None:
        """Return the user row for that Google `sub`, or `None`."""
        ...

    async def get_by_id(self, user_id: int) -> User | None:
        """Return the user row for our internal autoincrement id, or `None`.

        Used on the authenticated-request path to resolve a session's
        `user_id` to a `User` for downstream code without needing the
        `google_user_id` (which we don't keep in the session row).
        """
        ...

    async def upsert_from_google(
        self,
        *,
        google_user_id: str,
        email: str,
        name: str | None,
        picture_url: str | None,
    ) -> User:
        """Create a new user, or update an existing one's profile fields.

        Idempotent on `google_user_id`. Returns the persisted user with
        its auto-assigned `id` populated. The `updated_at` timestamp is
        bumped on every call so "last sign-in" can be inferred later.
        """
        ...


@runtime_checkable
class TokenStorePort(Protocol):
    """Encrypted-at-rest storage for a user's Google OAuth tokens."""

    async def save_for_user(self, user_id: int, tokens: OAuthTokens) -> None:
        """Insert-or-replace the token row for that user.

        The adapter is the only code that touches the encryption key;
        callers pass plaintext, get nothing in return. One row per user;
        re-authorising overwrites the previous token set.
        """
        ...

    async def get_for_user(self, user_id: int) -> OAuthTokens | None:
        """Decrypt and return that user's tokens, or `None` if absent."""
        ...


@runtime_checkable
class SessionStorePort(Protocol):
    """Manage server-side session records the HttpOnly cookie maps onto."""

    async def create(
        self,
        *,
        user_id: int,
        user_agent: str | None,
        ip_address: str | None,
    ) -> Session:
        """Mint a fresh session for that user and return it.

        The adapter generates the random `id`; callers must not assume
        any structure to it (it's opaque from the domain's POV).
        """
        ...

    async def get(self, session_id: str) -> Session | None:
        """Return the session row for that id, or `None` if revoked / unknown."""
        ...

    async def touch(self, session_id: str) -> None:
        """Bump `last_seen_at` to now. No-op if the session was revoked."""
        ...

    async def delete(self, session_id: str) -> None:
        """Revoke the session immediately. Sign-out path."""
        ...


# Awaitable-returning Protocols can be a pain to mock in some test setups;
# `runtime_checkable` makes `isinstance(x, OAuthProviderPort)` work, and the
# `Awaitable` import keeps mypy happy if a downstream wants to type a
# generic Awaitable[...] manually. Re-exported for convenience.
__all__ = [
    "AuthError",
    "AuthErrorKind",
    "AuthStartResult",
    "Awaitable",
    "DRIVE_FILE_SCOPE",
    "FreshAccessToken",
    "FreshTokenOutcome",
    "OAuthExchangeOutcome",
    "OAuthExchangeResult",
    "OAuthProviderPort",
    "OAuthRefreshOutcome",
    "OAuthRefreshResult",
    "OAuthTokens",
    "Session",
    "SessionLookupOutcome",
    "SessionStorePort",
    "SignInOutcome",
    "SignedInUser",
    "TokenStorePort",
    "User",
    "UserRepoPort",
]
