"""Auth routes — Google OAuth round-trip + session lifecycle.

Three browser-facing redirects + two JSON endpoints:

  * ``GET  /auth/google/start``    302 → Google's consent screen
  * ``GET  /auth/google/return``   302 → frontend after success/failure
  * ``POST /auth/sign-out``        clears the session cookie
  * ``GET  /auth/me``              JSON describing the signed-in user
  * ``GET  /auth/config``          tells the frontend whether sign-in is
                                    even configured (so we don't render
                                    a sign-in button against a dev backend
                                    that can't fulfil it)

The two redirect endpoints are *navigations*, not fetches — meaning the
browser follows them, mutating its address bar. The frontend never
inspects their JSON. The error path therefore redirects back to the
frontend with a query-string error code (e.g. ``?auth_error=denied``)
the SPA can render copy from.

Business logic lives in `AuthService`. This module's job is HTTP-shaped:
read cookies, verify state, set / clear cookies, redirect, normalise
error kinds to plain-English copy.
"""

from __future__ import annotations

import logging
from typing import Annotated, Final
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse

from captureshark.api.deps import (
    get_auth_service,
    get_cookie_signer,
    get_required_signed_in_user,
    get_sheet_connection_repo,
)
from captureshark.api.security import (
    OAUTH_STATE_COOKIE_NAME,
    OAUTH_STATE_MAX_AGE_SECONDS,
    SESSION_COOKIE_MAX_AGE_SECONDS,
    CookieSigner,
)
from captureshark.config import Settings, get_settings
from captureshark.domain.auth import AuthErrorKind, SignedInUser
from captureshark.domain.sheets import SheetConnection, SheetConnectionRepoPort
from captureshark.services.auth_service import AuthService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Frontend paths the browser is sent to after sign-in completes. Kept
# minimal for v1 — the SPA just reads the query params on its `/`.
_FRONTEND_SUCCESS_PATH: Final = "/"
_FRONTEND_ERROR_PATH: Final = "/"

# Map domain error kinds to short codes the frontend recognises.
_AUTH_ERROR_CODE_MAP: Final[dict[AuthErrorKind, str]] = {
    AuthErrorKind.OAUTH_DENIED: "denied",
    AuthErrorKind.INVALID_STATE: "state_mismatch",
    AuthErrorKind.OAUTH_FAILED: "oauth_failed",
    AuthErrorKind.INVALID_ID_TOKEN: "invalid_token",
    AuthErrorKind.UPSTREAM_UNAVAILABLE: "upstream_down",
    AuthErrorKind.MISSING_CONFIG: "not_configured",
    AuthErrorKind.SESSION_NOT_FOUND: "session_lost",
    AuthErrorKind.UNEXPECTED: "unexpected",
}


# --- /auth/google/start ----------------------------------------------------


@router.get("/google/start", include_in_schema=False)
async def google_start(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
    signer: Annotated[CookieSigner, Depends(get_cookie_signer)],
) -> Response:
    """Begin sign-in: stash a CSRF state cookie, redirect to Google."""
    redirect_uri = _derive_redirect_uri(request, settings)
    start = auth.start_google_oauth(redirect_uri=redirect_uri)
    response: Response = RedirectResponse(
        url=start.redirect_url, status_code=status.HTTP_302_FOUND
    )
    _set_oauth_state_cookie(response, signer.sign_oauth_state(start.state), settings)
    return response


# --- /auth/google/return ---------------------------------------------------


@router.get("/google/return", include_in_schema=False)
async def google_return(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
    signer: Annotated[CookieSigner, Depends(get_cookie_signer)],
) -> Response:
    """Receive Google's redirect, complete sign-in, set the session cookie."""
    # Google appends `error` directly when the user denies; short-circuit
    # without touching the service since there's no code to exchange.
    if (error_code := request.query_params.get("error")) is not None:
        logger.info(
            "OAuth denied at consent",
            extra={"google_error_code": error_code},
        )
        return _redirect_with_error(_AUTH_ERROR_CODE_MAP[AuthErrorKind.OAUTH_DENIED])

    code = request.query_params.get("code", "")
    state = request.query_params.get("state", "")
    if not code or not state:
        return _redirect_with_error(
            _AUTH_ERROR_CODE_MAP[AuthErrorKind.OAUTH_FAILED]
        )

    signed_state_cookie = request.cookies.get(OAUTH_STATE_COOKIE_NAME)
    cookie_state = (
        signer.unsign_oauth_state(signed_state_cookie)
        if signed_state_cookie
        else None
    )

    redirect_uri = _derive_redirect_uri(request, settings)
    user_agent = request.headers.get("user-agent")
    ip_address = _client_ip_from(request)

    outcome = await auth.handle_google_return(
        code=code,
        state_from_url=state,
        state_from_cookie=cookie_state,
        redirect_uri=redirect_uri,
        user_agent=user_agent,
        ip_address=ip_address,
    )
    if outcome[0] == "error":
        logger.warning(
            "OAuth callback failed",
            extra={
                "auth_error_kind": outcome[1].kind.value,
                "auth_error_detail": outcome[1].detail,
            },
        )
        return _redirect_with_error(_AUTH_ERROR_CODE_MAP[outcome[1].kind])

    response = _redirect_with_success()
    _clear_oauth_state_cookie(response, settings)
    _set_session_cookie(
        response, signer.sign_session_id(outcome[1].session.id), settings
    )
    return response


# --- /auth/sign-out --------------------------------------------------------


@router.post("/sign-out", status_code=status.HTTP_204_NO_CONTENT)
async def sign_out(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
    signer: Annotated[CookieSigner, Depends(get_cookie_signer)],
) -> Response:
    """Revoke the session and tell the browser to drop the cookie."""
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    session_id = _read_session_id_from(request, signer)
    if session_id is not None:
        await auth.sign_out(session_id)
    _clear_session_cookie(response, settings)
    return response


# --- /auth/me -------------------------------------------------------------


@router.get("/me")
async def me(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
    signer: Annotated[CookieSigner, Depends(get_cookie_signer)],
    connections: Annotated[SheetConnectionRepoPort, Depends(get_sheet_connection_repo)],
) -> Response:
    """Return the current signed-in user, or 401 if no valid session.

    Bundles the user's *connected sheet* (if any) so the frontend has
    everything it needs after one round-trip — no separate
    `/sheets/connection` call needed for the common app-load case.
    """
    session_id = _read_session_id_from(request, signer)
    if session_id is None:
        return _unauthenticated_response(settings)

    outcome = await auth.get_user_for_session(session_id)
    if outcome[0] == "error":
        # Stale or revoked session — clear the cookie so the browser
        # stops sending it on every subsequent request.
        return _unauthenticated_response(settings)
    signed_in = outcome[1]
    connection = await connections.get_for_user(signed_in.user.id)
    return JSONResponse(_signed_in_to_dto(signed_in, connection))


# --- /auth/config ---------------------------------------------------------


@router.get("/config")
async def auth_config(
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    """Tell the frontend whether sign-in is wired up server-side.

    The SPA hides the "Connect a sheet" CTA when this returns
    `configured: false` so a dev-mode build doesn't surface a button
    that's guaranteed to 503.

    Also exposes `google_app_id` (the Cloud project number derived
    from the OAuth client_id) so the frontend's Picker SDK has what
    it needs for `setAppId(...)` without a second round-trip.
    """
    configured = bool(
        settings.google_client_id
        and settings.google_client_secret
        and settings.session_secret_key
        and settings.token_encryption_key
    )
    return JSONResponse(
        {
            "configured": configured,
            "google_app_id": settings.google_app_id,
        }
    )


@router.get("/picker-token")
async def picker_token(
    signed_in: Annotated[SignedInUser, Depends(get_required_signed_in_user)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> Response:
    """Hand the frontend a live access token for the Picker SDK.

    Refreshes against Google transparently if expiry is near. The
    refresh-token never crosses the wire — this endpoint returns ONLY
    the access token + its `expires_at`, both of which a JS client can
    safely hold in memory for the duration of a Picker dialog.

    Authenticated route — 401 on no session.
    """
    outcome = await auth.get_fresh_access_token(signed_in.user.id)
    if outcome[0] == "error":
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={
                "error": {
                    "code": "session_lost",
                    "message": "Your sign-in expired. Sign in again.",
                    "details": {},
                }
            },
        )
    fresh = outcome[1]
    return JSONResponse(
        {
            "access_token": fresh.access_token,
            "expires_at": fresh.expires_at.isoformat(),
        }
    )


# --- Helpers --------------------------------------------------------------


def _derive_redirect_uri(request: Request, settings: Settings) -> str:
    """Build the absolute URL Google should redirect back to.

    Priority:

    1. ``settings.oauth_redirect_base_url`` if explicitly pinned (prod).
    2. Otherwise derive from the request — `Host` header + scheme,
       respecting `X-Forwarded-Proto` so tunnels that terminate TLS
       (ngrok, Cloudflare Tunnel) build `https://` URLs that match
       what's registered in Cloud Console.

    The path component is fixed: `<api_prefix>/auth/google/return`.
    """
    return_path = f"{settings.api_prefix}/auth/google/return"
    if settings.oauth_redirect_base_url:
        return f"{settings.oauth_redirect_base_url.rstrip('/')}{return_path}"
    forwarded_proto = (
        request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    )
    scheme = forwarded_proto or request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}{return_path}"


def _client_ip_from(request: Request) -> str | None:
    """Best-effort extraction of the originating client IP.

    Honours `X-Forwarded-For` (left-most entry = original client) when
    the request came through a proxy/tunnel; falls back to the socket
    peer otherwise. Stored only on the session row for "is this me?"
    UI later — we never use it as an auth signal.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or None
    return request.client.host if request.client else None


def _read_session_id_from(
    request: Request, signer: CookieSigner
) -> str | None:
    settings = get_settings()
    raw = request.cookies.get(settings.session_cookie_name)
    if raw is None:
        return None
    return signer.unsign_session_id(raw)


def _redirect_with_error(error_code: str) -> Response:
    return RedirectResponse(
        url=f"{_FRONTEND_ERROR_PATH}?{urlencode({'auth_error': error_code})}",
        status_code=status.HTTP_302_FOUND,
    )


def _redirect_with_success() -> Response:
    return RedirectResponse(
        url=f"{_FRONTEND_SUCCESS_PATH}?{urlencode({'signed_in': '1'})}",
        status_code=status.HTTP_302_FOUND,
    )


def _set_oauth_state_cookie(
    response: Response, signed_value: str, settings: Settings
) -> None:
    response.set_cookie(
        key=OAUTH_STATE_COOKIE_NAME,
        value=signed_value,
        max_age=OAUTH_STATE_MAX_AGE_SECONDS,
        httponly=True,
        secure=_use_secure_cookies(settings),
        samesite="lax",
        path="/",
    )


def _clear_oauth_state_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=OAUTH_STATE_COOKIE_NAME,
        path="/",
        secure=_use_secure_cookies(settings),
        samesite="lax",
    )


def _set_session_cookie(
    response: Response, signed_session_id: str, settings: Settings
) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=signed_session_id,
        max_age=SESSION_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        secure=_use_secure_cookies(settings),
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=settings.session_cookie_name,
        path="/",
        secure=_use_secure_cookies(settings),
        samesite="lax",
    )


def _use_secure_cookies(settings: Settings) -> bool:
    """Set the `Secure` cookie attribute outside of local dev.

    Dev (`environment=development`) runs over plain HTTP on localhost,
    where browsers reject `Secure` cookies. Tunnels in dev (Cloudflare,
    ngrok) terminate TLS upstream — they're not local HTTP — so we let
    the operator opt them in via `oauth_redirect_base_url` being an
    https URL. Anything else: assume HTTPS.
    """
    if settings.environment != "development":
        return True
    if settings.oauth_redirect_base_url and settings.oauth_redirect_base_url.startswith("https://"):
        return True
    return False


def _signed_in_to_dto(
    signed_in: SignedInUser, connection: SheetConnection | None
) -> dict[str, object]:
    """Shape the `SignedInUser` (+ optional connected sheet) for the wire.

    `has_drive_access` is the load-bearing flag the frontend reads to
    decide whether to render the post-OAuth retry screen ("Looks like
    a permission was skipped"). We do *not* expose the full
    `granted_scopes` set — knowing whether the Picker / save path can
    function is enough; the raw scope strings are an internal detail.

    `connected_sheet` is `null` when the user signed in but hasn't
    picked a sheet yet — the frontend uses that to auto-open the
    Picker. When present, the frontend skips straight to the save
    path and shows "Saving to: <display_name>" in the header.
    """
    return {
        "user": {
            "email": signed_in.user.email,
            "name": signed_in.user.name,
            "picture_url": signed_in.user.picture_url,
        },
        "session": {
            "created_at": signed_in.session.created_at.isoformat(),
            "last_seen_at": signed_in.session.last_seen_at.isoformat(),
        },
        "has_drive_access": signed_in.has_drive_access,
        "connected_sheet": (
            None
            if connection is None
            else {
                "spreadsheet_id": connection.spreadsheet_id,
                "display_name": connection.display_name,
                "worksheet_title": connection.worksheet_title,
            }
        ),
    }


def _unauthenticated_response(settings: Settings) -> Response:
    """401 + clear stale session cookie so the browser stops re-sending it."""
    response = JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content={
            "error": {
                "code": "not_signed_in",
                "message": "Not signed in.",
                "details": {},
            }
        },
    )
    _clear_session_cookie(response, settings)
    return response


# Re-export so unit tests can import everything from one path.
__all__ = ["router", "HTTPException"]
