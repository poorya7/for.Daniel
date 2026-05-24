"""Live-captions routes — mint AssemblyAI temp tokens for the browser.

One endpoint today: `POST /captures/live-token`. Returns a single-use
token the browser passes as the `?token=` query parameter on the
AssemblyAI streaming WebSocket URL.

Why POST not GET: minting a token is not idempotent on AssemblyAI's
side — every call burns a token slot. POST keeps tools/proxies from
silently retrying and double-billing.

Auth: open to anonymous callers, matching the v1 sketch's
"try-before-connect" pillar (broker can use voice capture without
signing in). Abuse is bounded by the existing per-IP rate limit in
`CostCapMiddleware`.
"""

from __future__ import annotations

import logging
from typing import Annotated, Final

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from captureshark.api.deps import get_live_captions_service
from captureshark.domain.live_captions import (
    LiveCaptionTokenError,
    LiveCaptionTokenErrorKind,
)
from captureshark.services.live_captions_service import LiveCaptionsService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["live-captions"])

# Plan: ~60 second TTL. Short enough that a leaked token is near-worthless;
# long enough to cover the browser round-trip + AudioWorklet warmup.
_TOKEN_TTL_SECONDS: Final = 60


class LiveCaptionTokenResponse(BaseModel):
    """Wire shape of a successful temp-token mint."""

    token: str
    expires_at: str  # ISO-8601 UTC, e.g. "2026-05-15T20:34:12+00:00"


_ERROR_TABLE: Final[dict[LiveCaptionTokenErrorKind, tuple[int, str, str]]] = {
    LiveCaptionTokenErrorKind.FEATURE_DISABLED: (
        status.HTTP_404_NOT_FOUND,
        "feature_disabled",
        "Live captions aren't turned on right now.",
    ),
    LiveCaptionTokenErrorKind.NOT_CONFIGURED: (
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "not_configured",
        "Live captions aren't set up on the server.",
    ),
    LiveCaptionTokenErrorKind.UPSTREAM_UNAVAILABLE: (
        status.HTTP_502_BAD_GATEWAY,
        "captions_unavailable",
        "Live captions are taking a moment — try again in a sec.",
    ),
    LiveCaptionTokenErrorKind.UPSTREAM_REJECTED: (
        status.HTTP_502_BAD_GATEWAY,
        "captions_unavailable",
        "Live captions are taking a moment — try again in a sec.",
    ),
    LiveCaptionTokenErrorKind.UNEXPECTED: (
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "captions_failed",
        "Something went wrong on our end. Try again in a moment.",
    ),
}


@router.post(
    "/captures/live-token",
    response_model=LiveCaptionTokenResponse,
    summary="Mint a temp AssemblyAI streaming token",
    responses={
        404: {"description": "Feature flag is off."},
        500: {"description": "Unexpected server error."},
        502: {"description": "AssemblyAI rejected or was unreachable."},
        503: {"description": "Server is missing AssemblyAI configuration."},
    },
)
async def mint_live_caption_token(
    service: Annotated[LiveCaptionsService, Depends(get_live_captions_service)],
) -> LiveCaptionTokenResponse | JSONResponse:
    """Return a single-session temp token for the AssemblyAI WebSocket."""
    outcome = await service.mint_session_token(
        expires_in_seconds=_TOKEN_TTL_SECONDS
    )
    if outcome[0] == "ok":
        token = outcome[1]
        return LiveCaptionTokenResponse(
            token=token.token,
            expires_at=token.expires_at.isoformat(),
        )
    return _error_response(outcome[1])


def _error_response(err: LiveCaptionTokenError) -> JSONResponse:
    http_status, code, message = _ERROR_TABLE[err.kind]
    return JSONResponse(
        status_code=http_status,
        content={
            "error": {
                "code": code,
                "message": message,
                "details": {},
            }
        },
    )
