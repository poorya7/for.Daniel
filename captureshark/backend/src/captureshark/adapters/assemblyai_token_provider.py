"""AssemblyAI temp-token adapter — implements `LiveCaptionTokenPort`.

Hits AssemblyAI's REST endpoint with the raw account API key, returns
the short-lived token the browser will use to open the streaming WS.

Captured docs:
  docs/_tests/stt_bakeoff/vendor-docs/assemblyai_temporary_token.md

Live docs:
  https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Final

import httpx

from captureshark.domain.live_captions import (
    LiveCaptionToken,
    LiveCaptionTokenError,
    LiveCaptionTokenErrorKind,
    LiveCaptionTokenOutcome,
    LiveCaptionTokenPort,
)

logger = logging.getLogger(__name__)

_TOKEN_ENDPOINT: Final = "https://streaming.assemblyai.com/v3/token"
# AssemblyAI accepts 1–600s. The plan calls for ~60s — short enough that
# a leaked token is near-worthless, long enough to cover the browser
# round-trip + AudioWorklet warmup before opening the WS.
_DEFAULT_TTL_SECONDS: Final = 60


class AssemblyAITokenProvider(LiveCaptionTokenPort):
    """Mints single-session temp tokens against AssemblyAI's REST API."""

    def __init__(self, *, api_key: str, http_client: httpx.AsyncClient) -> None:
        self._api_key = api_key
        self._http = http_client

    async def mint_token(
        self, *, expires_in_seconds: int = _DEFAULT_TTL_SECONDS
    ) -> LiveCaptionTokenOutcome:
        """Hit AssemblyAI's `/v3/token`, return the short-lived token.

        The endpoint replies `{"token": "..."}` — `expires_at` is derived
        client-side from the request time + the TTL we sent. AssemblyAI
        doesn't echo the expiry; computing it locally matches the contract
        on the wire and keeps the frontend's pre-emptive-refresh logic
        simple.
        """
        try:
            response = await self._http.get(
                _TOKEN_ENDPOINT,
                headers={"Authorization": self._api_key},
                params={"expires_in_seconds": expires_in_seconds},
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "assemblyai.token.network_error",
                extra={"error_class": exc.__class__.__name__},
            )
            return (
                "error",
                LiveCaptionTokenError(
                    kind=LiveCaptionTokenErrorKind.UPSTREAM_UNAVAILABLE,
                    detail=f"{exc.__class__.__name__}",
                ),
            )

        if response.status_code != httpx.codes.OK:
            logger.warning(
                "assemblyai.token.upstream_error",
                extra={
                    "status_code": response.status_code,
                    "body_prefix": response.text[:200],
                },
            )
            return (
                "error",
                LiveCaptionTokenError(
                    kind=LiveCaptionTokenErrorKind.UPSTREAM_REJECTED,
                    detail=f"HTTP {response.status_code}",
                ),
            )

        try:
            body = response.json()
        except ValueError:
            logger.warning("assemblyai.token.invalid_json")
            return (
                "error",
                LiveCaptionTokenError(
                    kind=LiveCaptionTokenErrorKind.UNEXPECTED,
                    detail="non-JSON response",
                ),
            )

        token = body.get("token") if isinstance(body, dict) else None
        if not isinstance(token, str) or not token:
            return (
                "error",
                LiveCaptionTokenError(
                    kind=LiveCaptionTokenErrorKind.UNEXPECTED,
                    detail="missing token field",
                ),
            )

        expires_at = datetime.now(UTC) + timedelta(seconds=expires_in_seconds)
        return ("ok", LiveCaptionToken(token=token, expires_at=expires_at))
