"""Google OAuth 2.0 adapter — implements `OAuthProviderPort`.

Tech-plan §7: redirect flow with the narrow `drive.file` scope. The frontend
never sees Google tokens; this adapter is the only code that reads them
plain. Encryption-at-rest happens one step further out, in the token store.

Why no `authlib` here even though the dep is installed: the surface we
need is tiny — one URL builder, two `POST` calls, and an `id_token`
verification — and the official `google-auth` library is already in
deps for the Sheets path. Using `httpx` + `google-auth` directly keeps
the failure modes legible and avoids dragging in authlib's session
state machine for two endpoint calls.

Failure-mode contract per `OAuthProviderPort`:

  * `httpx` network errors / 5xx           → `UPSTREAM_UNAVAILABLE`
  * Google returns `error=access_denied`   → `OAUTH_DENIED`
  * Token endpoint 4xx (other)             → `OAUTH_FAILED`
  * `id_token` signature/issuer mismatch   → `INVALID_ID_TOKEN`
  * `Settings.google_client_id` unset      → `MISSING_CONFIG`
  * Anything else                          → `UNEXPECTED` (logged)

No raw token values are logged, ever.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Final, Literal, Protocol, cast, runtime_checkable
from urllib.parse import urlencode

import httpx
from google.auth.transport import requests as google_auth_requests
from google.oauth2 import id_token as google_id_token

from captureshark.domain.auth import (
    AuthError,
    AuthErrorKind,
    OAuthExchangeOutcome,
    OAuthExchangeResult,
    OAuthProviderPort,
    OAuthRefreshOutcome,
    OAuthRefreshResult,
)

logger = logging.getLogger(__name__)

# Google's published endpoints. Pinning explicitly so a hijacked discovery
# document can't redirect us — the values are stable per Google's docs.
_AUTHORIZE_URL: Final = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL: Final = "https://oauth2.googleapis.com/token"

_DEFAULT_TIMEOUT_SECONDS: Final = 15.0

# Scopes we ask for. Matches `docs/_dev/02_google-oauth-setup.md`.
# `openid` is what makes Google return an `id_token` (the JWT we read
# `sub`/`email`/`name`/`picture` from). `email` and `profile` flesh out
# the claim set. `drive.file` is the narrow Sheets-via-Picker scope.
_REQUESTED_SCOPES: Final = (
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive.file",
)


@runtime_checkable
class IdTokenVerifierPort(Protocol):
    """Verifier seam — what `GoogleOAuthProvider` calls to validate the id_token JWT.

    Lives here (not in `domain/`) because it's a narrow adapter-internal
    concern, not a domain concept. Production wiring uses
    `GoogleIdTokenVerifier`, a thin wrapper around
    `google_id_token.verify_oauth2_token`. Tests inject a fake that
    returns canned claims or raises `ValueError` to pin our error
    mapping without depending on Google's JWKS endpoint.

    Contract: returns the decoded claims dict on success, raises
    `ValueError` on signature/issuer/audience/expiry failure. The
    caller (`GoogleOAuthProvider._verify_id_token`) catches that and
    maps to `INVALID_ID_TOKEN`.
    """

    def verify(self, raw_id_token: str, *, audience: str) -> dict[str, Any]: ...


class GoogleIdTokenVerifier:
    """Production verifier — thin wrapper over `google_id_token.verify_oauth2_token`.

    Why a class instead of a function: the Protocol expects a callable
    `verify(...)`, and a class makes the type-surface match obvious.
    Per-instance state is irrelevant; the underlying library handles
    JWKS caching at module level.
    """

    def verify(self, raw_id_token: str, *, audience: str) -> dict[str, Any]:
        claims = google_id_token.verify_oauth2_token(  # type: ignore[no-untyped-call]
            raw_id_token,
            google_auth_requests.Request(),
            audience,
        )
        if not isinstance(claims, dict):
            raise ValueError(f"verify_oauth2_token returned non-dict: {type(claims).__name__}")
        return cast(dict[str, Any], claims)


class GoogleOAuthProvider(OAuthProviderPort):
    """Production implementation against Google's OAuth 2.0 endpoints."""

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        http_client: httpx.AsyncClient | None = None,
        id_token_verifier: IdTokenVerifierPort | None = None,
    ) -> None:
        if not client_id or not client_secret:
            # Defensive guard — `api/deps.py` should have already enforced
            # this, but a misconfigured caller shouldn't get past `__init__`.
            raise ValueError("client_id and client_secret are required")
        self._client_id = client_id
        self._client_secret = client_secret
        # Tests inject a `httpx.AsyncClient` backed by `MockTransport`.
        # In prod, `api/deps.py` shares a long-lived client across requests.
        self._http = http_client or httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_SECONDS)
        # Tests inject a fake verifier; production uses the real one.
        # The `or` is intentional rather than `?:` so a future caller
        # passing an explicit `id_token_verifier=None` still gets the
        # safe production default.
        self._id_token_verifier: IdTokenVerifierPort = (
            id_token_verifier or GoogleIdTokenVerifier()
        )

    # ----- OAuthProviderPort API ------------------------------------------

    def build_authorization_url(self, *, state: str, redirect_uri: str) -> str:
        params = {
            "client_id": self._client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(_REQUESTED_SCOPES),
            "state": state,
            # `offline` so Google issues a refresh_token. `prompt=consent`
            # is the documented way to *guarantee* a refresh_token even on
            # repeat authorisations — without it, Google returns one only
            # on first consent and silently omits it after. The minor UX
            # cost (consent screen on every sign-in) is the right trade
            # for a server that can't afford to suddenly lose the ability
            # to refresh a user's tokens.
            "access_type": "offline",
            "prompt": "consent",
            # `include_granted_scopes` lets returning users keep scopes
            # from prior authorisations even if we ever shrink our list.
            "include_granted_scopes": "true",
        }
        return f"{_AUTHORIZE_URL}?{urlencode(params)}"

    async def exchange_code(
        self, *, code: str, redirect_uri: str
    ) -> OAuthExchangeOutcome:
        token_outcome = await self._post_token(
            data={
                "code": code,
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            context="exchange_code",
        )
        if token_outcome[0] == "error":
            return token_outcome  # already an ("error", AuthError) pair
        payload = token_outcome[1]

        access_token = _required_str(payload, "access_token")
        refresh_token = _required_str(payload, "refresh_token")
        id_token_str = _required_str(payload, "id_token")
        if not access_token or not refresh_token or not id_token_str:
            return _err(
                AuthErrorKind.OAUTH_FAILED,
                "Google token response was missing access_token/refresh_token/id_token.",
            )

        claims_outcome = self._verify_id_token(id_token_str)
        if claims_outcome[0] == "error":
            return claims_outcome

        claims = claims_outcome[1]
        return (
            "ok",
            OAuthExchangeResult(
                google_user_id=str(claims["sub"]),
                email=str(claims.get("email", "")),
                name=_optional_str(claims, "name"),
                picture_url=_optional_str(claims, "picture"),
                access_token=access_token,
                refresh_token=refresh_token,
                access_token_expires_at=_compute_expiry(payload),
                granted_scopes=_parse_scopes(payload),
            ),
        )

    async def refresh_access_token(
        self, *, refresh_token: str
    ) -> OAuthRefreshOutcome:
        token_outcome = await self._post_token(
            data={
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            context="refresh_access_token",
        )
        if token_outcome[0] == "error":
            return token_outcome
        payload = token_outcome[1]

        access_token = _required_str(payload, "access_token")
        if not access_token:
            return _err(
                AuthErrorKind.OAUTH_FAILED,
                "Google refresh response was missing access_token.",
            )

        # Google sometimes rotates the refresh_token on use; surface it if
        # it changed so the token store can persist the new one.
        rotated_refresh = _optional_str(payload, "refresh_token")
        return (
            "ok",
            OAuthRefreshResult(
                access_token=access_token,
                access_token_expires_at=_compute_expiry(payload),
                granted_scopes=_parse_scopes(payload),
                refresh_token=rotated_refresh,
            ),
        )

    # ----- internals -------------------------------------------------------

    async def _post_token(
        self, *, data: dict[str, str], context: str
    ) -> _PayloadOutcome:
        """POST to Google's token endpoint with errors-as-data semantics.

        The return type is intentionally not the public `OAuthExchangeOutcome`
        — both `exchange_code` and `refresh_access_token` reuse this helper
        and need to keep mapping the dict payload further. We only flatten
        to the public shape at the end of each method.
        """
        try:
            response = await self._http.post(
                _TOKEN_URL,
                data=data,
                headers={"Accept": "application/json"},
            )
        except httpx.TimeoutException:
            logger.warning(
                "oauth token request timed out",
                extra={"context": context},
            )
            return _err(
                AuthErrorKind.UPSTREAM_UNAVAILABLE,
                f"Google token endpoint timed out during {context}.",
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "oauth token request network error",
                extra={"context": context, "exc_class": exc.__class__.__name__},
            )
            return _err(
                AuthErrorKind.UPSTREAM_UNAVAILABLE,
                f"Google token endpoint network error during {context}: {exc.__class__.__name__}.",
            )

        if response.status_code >= 500:
            logger.warning(
                "oauth token endpoint 5xx",
                extra={"context": context, "status": response.status_code},
            )
            return _err(
                AuthErrorKind.UPSTREAM_UNAVAILABLE,
                f"Google token endpoint returned {response.status_code} during {context}.",
            )

        try:
            payload = response.json()
        except ValueError:
            logger.warning(
                "oauth token endpoint non-json body",
                extra={"context": context, "status": response.status_code},
            )
            return _err(
                AuthErrorKind.OAUTH_FAILED,
                f"Google token endpoint returned non-JSON during {context}.",
            )

        if response.status_code >= 400:
            error_code = str(payload.get("error", "")).lower()
            # `error_description` is Google's human-readable detail
            # (e.g. "Token has been expired or revoked"). Capture it
            # alongside `error` — both are non-credential strings.
            error_description = payload.get("error_description")
            logger.warning(
                "oauth token endpoint rejected",
                extra={
                    "context": context,
                    "status": response.status_code,
                    "google_error": error_code,
                    "google_error_description": error_description,
                },
            )
            if error_code == "access_denied":
                return _err(
                    AuthErrorKind.OAUTH_DENIED,
                    "User declined the consent screen.",
                )
            return _err(
                AuthErrorKind.OAUTH_FAILED,
                f"Google rejected the {context}: {error_code or 'unspecified error'}.",
            )

        if not isinstance(payload, dict):
            return _err(
                AuthErrorKind.OAUTH_FAILED,
                f"Google token endpoint returned a non-object body during {context}.",
            )
        return ("ok", cast(dict[str, Any], payload))

    def _verify_id_token(self, raw_id_token: str) -> _PayloadOutcome:
        """Verify and decode the `id_token` JWT via the injected verifier.

        Production verifier (`GoogleIdTokenVerifier`) wraps `google-auth`,
        which handles JWKS retrieval, signature check, issuer check,
        audience check (against our client_id), and expiry. A
        `ValueError` from the verifier means *the token did not
        validate*, not a network error — we map it to
        `INVALID_ID_TOKEN`.
        """
        try:
            claims = self._id_token_verifier.verify(
                raw_id_token, audience=self._client_id
            )
        except ValueError as exc:
            return _err(
                AuthErrorKind.INVALID_ID_TOKEN,
                f"id_token verification failed: {exc}",
            )
        if not claims.get("sub"):
            return _err(
                AuthErrorKind.INVALID_ID_TOKEN,
                "id_token verified but had no `sub` claim.",
            )
        return ("ok", claims)


# --- Local helpers ----------------------------------------------------------

# Module-private outcome alias for helpers that return Google's raw token
# payload as a `dict`. The two public methods (`exchange_code`,
# `refresh_access_token`) wrap this into the `OAuthExchangeOutcome` /
# `OAuthRefreshOutcome` shapes the domain expects.
_PayloadOutcome = (
    tuple[Literal["ok"], dict[str, Any]] | tuple[Literal["error"], AuthError]
)


def _err(kind: AuthErrorKind, detail: str) -> tuple[Literal["error"], AuthError]:
    """Compact error tuple constructor — preserves the discriminator narrowing."""
    return ("error", AuthError(kind=kind, detail=detail))


def _required_str(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    return str(value) if isinstance(value, str) else ""


def _optional_str(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) and value else None


def _parse_scopes(payload: dict[str, Any]) -> frozenset[str]:
    """Parse the `scope` field — space-separated per RFC 6749 §5.1."""
    raw = payload.get("scope")
    if not isinstance(raw, str):
        return frozenset()
    return frozenset(s for s in raw.split(" ") if s)


def _compute_expiry(payload: dict[str, Any]) -> datetime:
    """Compute the absolute expiry from `expires_in` seconds.

    Defaults to 1 hour (Google's documented default) if `expires_in` is
    missing or unparseable. Pinning a default here means downstream code
    can rely on `access_token_expires_at` always being set.
    """
    raw = payload.get("expires_in")
    try:
        seconds = int(raw) if raw is not None else 3600
    except (TypeError, ValueError):
        seconds = 3600
    return datetime.now(UTC) + timedelta(seconds=seconds)
