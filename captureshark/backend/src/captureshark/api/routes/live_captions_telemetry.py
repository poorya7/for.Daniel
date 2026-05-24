"""Live-captions telemetry endpoint.

Receives a small JSON summary at the end of each live-captions session
and logs it as a structured info record. Powers two questions:
  1. Is the streaming pipeline healthy in production? (latency, fallback
     rate, partial cadence, error kinds)
  2. Does the broker correction-rate at review time trend with provider
     accuracy? (correction-rate lands in a follow-up commit — the
     session_id minted here is the join key.)

The endpoint is open to anonymous callers and best-effort by design.
The frontend never blocks on the response and silently swallows failures
— losing a telemetry record is preferable to slowing down a stop-tap.

Privacy posture: the schema is bounded with `extra="forbid"`. No raw
transcript, no audio bytes, no field values — only structural metrics.
If any new field looks like it could carry PII, tighten the schema, do
NOT silently log it.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

router = APIRouter(tags=["live-captions-telemetry"])


# Outcome from the streaming hook's POV. Maps to fallback-triggered:
#   "streamed"    → live captions produced a usable transcript (no fallback)
#   "empty"       → WS opened, no usable transcript (caller falls back to Whisper)
#   "error"       → WS errored / never opened (caller falls back to Whisper)
#   "stopped"     → hard stop (sheet closed mid-session); no fallback used
LiveCaptionOutcome = Literal["streamed", "empty", "error", "stopped"]


class LiveCaptionsTelemetryPayload(BaseModel):
    """Wire shape of one session's metrics summary."""

    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=8, max_length=64)
    """Client-minted UUID-like session identifier. Used as the join key
    when correction-rate telemetry lands in a later commit."""

    provider: Literal["assemblyai"] = "assemblyai"
    """Streaming provider in use. Single-valued today; future-proofed for
    the vendor-swap insurance scenario where the harness picks a different
    winner. Keep it constrained so dashboards stay tidy."""

    outcome: LiveCaptionOutcome

    total_session_ms: int = Field(ge=0, le=3_600_000)
    """Wall-clock duration of the session from start() to terminal state."""

    first_partial_ms: int | None = Field(default=None, ge=0, le=300_000)
    """Time from start() to the first non-empty partial. `None` if no
    partial ever arrived (matches outcome=error / stopped / some empty)."""

    partial_count: int = Field(default=0, ge=0, le=10_000)
    """Total partials (interim + finalised). Sanity-bounded so a stuck
    socket can't pollute logs."""

    p90_inter_partial_ms: int | None = Field(default=None, ge=0, le=60_000)
    """P90 of inter-partial gaps. `None` when fewer than 3 partials
    arrived (sample too small for a percentile to mean anything)."""

    max_inter_partial_ms: int | None = Field(default=None, ge=0, le=60_000)
    """Largest gap between consecutive partials. Catches the 16s-dead-air
    cadence regression the round-3 review surfaced. `None` when fewer
    than 2 partials arrived."""

    transcript_length: int = Field(ge=0, le=20_000)
    """Character count of the final transcript handed off to the caller.
    Zero for outcome=empty / error / stopped. NEVER the transcript text
    itself."""

    error_kind: str | None = Field(default=None, max_length=64)
    """Short identifier for the failure path when outcome=error. Examples:
    `connect_timeout`, `token_fetch_failed`, `ws_closed`, `unexpected`.
    Free-form on the wire; tighten if a real taxonomy emerges."""

    user_agent: str | None = Field(default=None, max_length=512)
    """`navigator.userAgent` so we can split metrics by device / browser
    in dashboards. Cap matches the client-errors endpoint."""


@router.post(
    "/telemetry/live-captions",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Receive a live-captions session summary",
)
async def report_live_captions_telemetry(
    payload: LiveCaptionsTelemetryPayload,
) -> None:
    """Log the summary as a structured info record. No response body.

    Returning 204 — the frontend is fire-and-forget; nothing to read back.
    The log line is the artefact downstream dashboards consume.
    """
    logger.info(
        "live captions telemetry",
        extra={
            "lc_session_id": payload.session_id,
            "lc_provider": payload.provider,
            "lc_outcome": payload.outcome,
            "lc_total_session_ms": payload.total_session_ms,
            "lc_first_partial_ms": payload.first_partial_ms,
            "lc_partial_count": payload.partial_count,
            "lc_p90_inter_partial_ms": payload.p90_inter_partial_ms,
            "lc_max_inter_partial_ms": payload.max_inter_partial_ms,
            "lc_transcript_length": payload.transcript_length,
            "lc_error_kind": payload.error_kind,
            "lc_user_agent": payload.user_agent,
        },
    )
