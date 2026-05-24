"""Live-captions domain — temp-token minting for AssemblyAI streaming.

The browser opens the AssemblyAI WebSocket directly. Browsers can't set
`Authorization` headers on a WS handshake, and we don't want the raw
AssemblyAI API key reaching the browser anyway — so we mint a *temporary*
token server-side and the browser passes it as a query parameter on the
WS URL.

This module defines the Port + types. The adapter (`adapters/
assemblyai_token_provider.py`) implements the HTTP call; the service
(`services/live_captions_service.py`) orchestrates.

Per AssemblyAI's docs:
  * Each temp token is single-session — burning more than one session
    requires minting a new token.
  * `expires_in_seconds` controls the window during which the token can
    be USED to open a session (not how long the session can run).
  * The session itself, once opened, can run up to `max_session_duration_seconds`
    (default 3 hours, the AssemblyAI account-wide ceiling). We leave that
    at the default until telemetry warrants tightening.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal, Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class LiveCaptionToken:
    """A short-lived token the browser uses to open one AssemblyAI session.

    `expires_at` is the absolute UTC instant the token becomes invalid for
    opening new sessions. The frontend uses it to decide whether to
    request a fresh token before kicking off the WS (a stale token = an
    immediate handshake error which we'd rather pre-empt).
    """

    token: str
    expires_at: datetime


class LiveCaptionTokenErrorKind(StrEnum):
    """Coarse error categories mapped to user-facing copy at the API layer."""

    # `LIVE_CAPTIONS_ENABLED=false` — the surface is dark. Returned as 404
    # to express "this isn't a thing right now" rather than "try again later".
    FEATURE_DISABLED = "feature_disabled"
    # `ASSEMBLYAI_API_KEY` missing in `.env`. Returned as 503 — the
    # operator (not the user) needs to act.
    NOT_CONFIGURED = "not_configured"
    # AssemblyAI's REST endpoint refused us (auth, quota, etc.). Returned
    # as 502 — upstream is the problem, not the client.
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    UPSTREAM_REJECTED = "upstream_rejected"
    # Anything we didn't anticipate.
    UNEXPECTED = "unexpected"


@dataclass(frozen=True, slots=True)
class LiveCaptionTokenError:
    """Error-shape of a token-minting run."""

    kind: LiveCaptionTokenErrorKind
    detail: str


LiveCaptionTokenOutcome = (
    tuple[Literal["ok"], LiveCaptionToken]
    | tuple[Literal["error"], LiveCaptionTokenError]
)


@runtime_checkable
class LiveCaptionTokenPort(Protocol):
    """Adapter interface: mint a single-session AssemblyAI token.

    Implementations MUST return an outcome rather than raising on
    upstream failure — auth, quota, network are error-as-data. Bugs
    (programmer errors) still bubble.
    """

    async def mint_token(self, *, expires_in_seconds: int) -> LiveCaptionTokenOutcome:
        """Mint a temp token for one AssemblyAI streaming session."""
        ...
