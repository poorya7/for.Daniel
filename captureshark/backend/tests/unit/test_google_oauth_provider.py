"""Unit tests for `adapters/google_oauth_provider.GoogleOAuthProvider`.

Two seams exercised:

  * **Wire** — `httpx.MockTransport` stubs Google's token endpoint;
    we pin the response → outcome mapping (200/4xx/5xx/timeout/non-JSON).
  * **ID-token verifier** — a fake `IdTokenVerifierPort` implementation
    returns canned claims or raises `ValueError`. Tests pin our
    error mapping without hitting Google's JWKS endpoint.

The verifier seam was added in §4 specifically so the success path of
`exchange_code` can be tested without network. Without it, the only
options are network calls (flaky, slow) or monkeypatching Google's
library (less honest about the contract). The Protocol stays
adapter-local; it's not a domain concept.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from captureshark.adapters.google_oauth_provider import (
    GoogleOAuthProvider,
    IdTokenVerifierPort,
)
from captureshark.domain.auth import AuthErrorKind

# --- Fakes ----------------------------------------------------------------


class FakeVerifier:
    """In-memory `IdTokenVerifierPort`. Returns canned claims OR raises ValueError."""

    def __init__(
        self,
        *,
        claims: dict[str, Any] | None = None,
        raises: ValueError | None = None,
    ) -> None:
        self._claims = claims
        self._raises = raises
        self.calls: list[tuple[str, str]] = []

    def verify(self, raw_id_token: str, *, audience: str) -> dict[str, Any]:
        self.calls.append((raw_id_token, audience))
        if self._raises is not None:
            raise self._raises
        if self._claims is None:
            raise AssertionError("FakeVerifier was called without canned claims")
        return self._claims


_VALID_CLAIMS: dict[str, Any] = {
    "sub": "google-sub-abc",
    "email": "maria@example.com",
    "name": "Maria Lopez",
    "picture": "https://example.com/maria.jpg",
}


def _make_http_client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler, timeout=5.0)


def _build_provider(
    *,
    handler: httpx.MockTransport,
    verifier: IdTokenVerifierPort | None = None,
) -> GoogleOAuthProvider:
    return GoogleOAuthProvider(
        client_id="cli-123.apps.googleusercontent.com",
        client_secret="secret-xyz",
        http_client=_make_http_client(handler),
        id_token_verifier=verifier or FakeVerifier(claims=_VALID_CLAIMS),
    )


def _ok_token_response(
    *,
    access_token: str = "access-1",
    refresh_token: str | None = "refresh-1",
    id_token: str | None = "id.token.jwt",
    expires_in: int = 3600,
    scope: str = "openid email https://www.googleapis.com/auth/drive.file",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "access_token": access_token,
        "expires_in": expires_in,
        "scope": scope,
        "token_type": "Bearer",
    }
    if refresh_token is not None:
        body["refresh_token"] = refresh_token
    if id_token is not None:
        body["id_token"] = id_token
    return body


# --- build_authorization_url ----------------------------------------------


def test_build_authorization_url_carries_required_params() -> None:
    """Pin the URL shape — a future refactor accidentally dropping
    `access_type=offline` would silently break refresh tokens."""
    handler = httpx.MockTransport(lambda req: httpx.Response(200, json={}))
    provider = _build_provider(handler=handler)
    url = provider.build_authorization_url(
        state="state-1", redirect_uri="http://localhost/return"
    )
    parsed = urlparse(url)
    assert parsed.netloc == "accounts.google.com"
    assert parsed.path == "/o/oauth2/v2/auth"
    params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
    assert params["client_id"] == "cli-123.apps.googleusercontent.com"
    assert params["redirect_uri"] == "http://localhost/return"
    assert params["state"] == "state-1"
    assert params["response_type"] == "code"
    # The non-negotiable ones for offline access + guaranteed refresh token.
    assert params["access_type"] == "offline"
    assert params["prompt"] == "consent"
    # Required scopes present (order-agnostic).
    scopes = set(params["scope"].split(" "))
    assert "openid" in scopes
    assert "https://www.googleapis.com/auth/drive.file" in scopes


# --- exchange_code: success path ------------------------------------------


@pytest.mark.asyncio
async def test_exchange_code_success_returns_full_result() -> None:
    """200 + verified claims → OAuthExchangeResult with all fields populated."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json=_ok_token_response())
    )
    provider = _build_provider(handler=handler)

    outcome = await provider.exchange_code(
        code="auth-code-1", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "ok"
    result = outcome[1]
    assert result.google_user_id == "google-sub-abc"
    assert result.email == "maria@example.com"
    assert result.name == "Maria Lopez"
    assert result.picture_url == "https://example.com/maria.jpg"
    assert result.access_token == "access-1"
    assert result.refresh_token == "refresh-1"
    assert "https://www.googleapis.com/auth/drive.file" in result.granted_scopes


# --- exchange_code: missing required fields in 200 body -------------------


@pytest.mark.asyncio
async def test_exchange_code_missing_id_token_is_oauth_failed() -> None:
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json=_ok_token_response(id_token=None))
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED


@pytest.mark.asyncio
async def test_exchange_code_missing_access_token_is_oauth_failed() -> None:
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json=_ok_token_response(access_token=""))
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED


@pytest.mark.asyncio
async def test_exchange_code_missing_refresh_token_is_oauth_failed() -> None:
    """Exchange path REQUIRES a refresh token — `prompt=consent` should
    guarantee one. If Google returns 200 without one, something is
    wrong with our request shape and we want to fail loud."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json=_ok_token_response(refresh_token=None))
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED


# --- exchange_code: ID-token verification failures ------------------------


@pytest.mark.asyncio
async def test_exchange_code_verifier_raises_value_error_is_invalid_id_token() -> None:
    """Security-critical: if the verifier rejects the token (bad
    signature, wrong issuer, expired) we MUST surface INVALID_ID_TOKEN.

    Without this branch covered, a future refactor that silently
    swallows the ValueError would let an attacker replay any
    bear-claims-shaped token. This is the test that guards that."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json=_ok_token_response())
    )
    provider = _build_provider(
        handler=handler,
        verifier=FakeVerifier(raises=ValueError("Token signature invalid.")),
    )
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.INVALID_ID_TOKEN


@pytest.mark.asyncio
async def test_exchange_code_verifier_returns_no_sub_is_invalid_id_token() -> None:
    """Verified but no `sub` claim → INVALID_ID_TOKEN. Defensive — the
    verifier shouldn't return claims without `sub`, but we don't trust
    that promise blindly because `sub` is the only stable user id."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json=_ok_token_response())
    )
    provider = _build_provider(
        handler=handler,
        verifier=FakeVerifier(claims={"email": "maria@example.com"}),  # no `sub`
    )
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.INVALID_ID_TOKEN


# --- exchange_code: 4xx / 5xx / network ------------------------------------


@pytest.mark.asyncio
async def test_exchange_code_access_denied_is_oauth_denied() -> None:
    handler = httpx.MockTransport(
        lambda req: httpx.Response(400, json={"error": "access_denied"})
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_DENIED


@pytest.mark.asyncio
async def test_exchange_code_other_4xx_is_oauth_failed() -> None:
    handler = httpx.MockTransport(
        lambda req: httpx.Response(400, json={"error": "invalid_grant"})
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED


@pytest.mark.asyncio
async def test_exchange_code_5xx_is_upstream_unavailable() -> None:
    handler = httpx.MockTransport(
        lambda req: httpx.Response(503, json={"error": "service unavailable"})
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.UPSTREAM_UNAVAILABLE


@pytest.mark.asyncio
async def test_exchange_code_timeout_is_upstream_unavailable() -> None:
    """Synthetic timeout — `MockTransport` raises `TimeoutException`."""

    def raise_timeout(req: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=req)

    handler = httpx.MockTransport(raise_timeout)
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.UPSTREAM_UNAVAILABLE


@pytest.mark.asyncio
async def test_exchange_code_non_json_body_is_oauth_failed() -> None:
    """Sometimes a proxy returns an HTML error page mid-outage — we
    must not crash, just report cleanly."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(
            200, content=b"<html>nope</html>", headers={"content-type": "text/html"}
        )
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED


@pytest.mark.asyncio
async def test_exchange_code_json_array_body_is_oauth_failed() -> None:
    """200 + `[]` body (instead of dict) — defensive shape check."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json=[1, 2, 3])
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.exchange_code(
        code="x", redirect_uri="http://localhost/return"
    )
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED


# --- refresh_access_token --------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_returns_new_access_token() -> None:
    handler = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={"access_token": "fresh-1", "expires_in": 3600, "scope": "openid"},
        )
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.refresh_access_token(refresh_token="r-1")
    assert outcome[0] == "ok"
    assert outcome[1].access_token == "fresh-1"
    # No rotated refresh_token in the response → the field is None.
    assert outcome[1].refresh_token is None


@pytest.mark.asyncio
async def test_refresh_surfaces_rotated_refresh_token() -> None:
    """Google occasionally rotates the refresh token; when it does,
    we surface the new one so the token store can persist it."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={
                "access_token": "fresh-1",
                "refresh_token": "rotated-r-2",
                "expires_in": 3600,
                "scope": "openid",
            },
        )
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.refresh_access_token(refresh_token="r-1")
    assert outcome[0] == "ok"
    assert outcome[1].refresh_token == "rotated-r-2"


@pytest.mark.asyncio
async def test_refresh_4xx_is_oauth_failed() -> None:
    handler = httpx.MockTransport(
        lambda req: httpx.Response(
            400, json={"error": "invalid_grant"}
        )
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.refresh_access_token(refresh_token="dead-1")
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED


@pytest.mark.asyncio
async def test_refresh_missing_access_token_is_oauth_failed() -> None:
    """200 with no access_token field — Google API contract violation."""
    handler = httpx.MockTransport(
        lambda req: httpx.Response(200, json={"expires_in": 3600})
    )
    provider = _build_provider(handler=handler)
    outcome = await provider.refresh_access_token(refresh_token="r-1")
    assert outcome[0] == "error"
    assert outcome[1].kind == AuthErrorKind.OAUTH_FAILED
