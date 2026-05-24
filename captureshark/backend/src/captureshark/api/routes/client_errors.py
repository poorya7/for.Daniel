"""Client-side error reporting endpoint.

Wired in §3 so it's ready when the React error boundary lands in §7.
The frontend's `componentDidCatch` POSTs here with the rendered
exception's message, the React component stack, the build version,
and (when known) the request ID of the last fetch that ran before the
crash. We log it as a structured warning so support can correlate a
broker-reported bug to backend logs via the request ID.

Why a POST endpoint rather than just `console.error`: the SPA can
crash on a phone we can't access. Without a server-side trail, a
broker says "the app went blank when I tapped Save" and we have
nothing. With this endpoint, we have a JSON warning carrying enough
detail to find the right slice of backend logs.

Privacy posture: the body shape is bounded and validated. No raw
form contents, no captured-text fields, no token strings. The error
message and component stack are the cost of useful debugging; if those
ever start carrying PII (e.g. an exception message that interpolates
a phone number), the schema here gets tightened — not the logging.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

router = APIRouter(tags=["client-errors"])


class ClientErrorReport(BaseModel):
    """Wire shape of a single client-side crash report."""

    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=2000)
    """The error's `message` (e.g. `"Cannot read property 'foo' of undefined"`)."""

    component_stack: str | None = Field(default=None, max_length=8000)
    """React's component stack from `componentDidCatch`'s second arg.
    Capped to keep accidental log-flooding bounded."""

    build_version: str | None = Field(default=None, max_length=64)
    """The frontend build the user was running (`__APP_VERSION__` or similar
    set at build time). Useful when a bug only repros on a stale tab."""

    last_request_id: str | None = Field(default=None, max_length=64)
    """The `X-Request-ID` from the most recent backend response the SPA
    saw before crashing. Lets us join client-side and server-side logs."""

    user_agent: str | None = Field(default=None, max_length=512)
    """Browser-reported `navigator.userAgent`. Useful when a crash only
    happens on, say, iOS Safari."""


@router.post(
    "/client-errors",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Receive a frontend error-boundary report",
)
async def report_client_error(payload: ClientErrorReport) -> None:
    """Log the report as a structured warning. No body in the response.

    Returning 204 (no content) — the frontend doesn't need anything
    back; the boundary already rendered its fallback locally. We just
    want a durable record server-side.
    """
    logger.warning(
        "client error reported",
        extra={
            "client_message": payload.message,
            "client_component_stack": payload.component_stack,
            "client_build_version": payload.build_version,
            "client_last_request_id": payload.last_request_id,
            "client_user_agent": payload.user_agent,
        },
    )
