"""Cost cap middleware — per-IP rate limit + daily $-spend kill-switch.

Protects `/captures` and `/captures/stream` from runaway costs:

- Per-IP token bucket: limits to N requests per minute and M per hour.
  Generous for real users; lethal for a bot loop.
- Daily $-spend kill-switch: tracks estimated USD spend per UTC day.
  Once cumulative spend exceeds the configured cap, new requests are
  refused until 00:00 UTC. The estimate is intentionally conservative
  (~2x typical per-call cost) so a misestimate errs on the side of
  refusing a few legit calls rather than letting bills run.

State is in-memory — correct for our single-process uvicorn deploy.
Multi-worker / multi-host would need a shared store (Redis); add
when we cross that bridge.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from threading import Lock
from typing import Final

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)

# Conservative per-call cost estimates, in USD. Real costs:
#   text path (gpt-4o-mini)            ≈ $0.0005 / call
#   voice path (whisper-1 + extractor) ≈ $0.0035 / call (30s recording)
#   photo path (gpt-5 reasoning=min)   ≈ $0.0200 / call (1500px image)
# We round generously upward so a misestimate refuses a few legit calls
# rather than overshoots a real bill. Refine later if we wire each
# vendor's per-call `usage` field through to the middleware.
_TEXT_COST_USD: Final = 0.001
_VOICE_COST_USD: Final = 0.005
_PHOTO_COST_USD: Final = 0.025

# Only POSTs to capture endpoints are guarded — GETs (e.g. swagger,
# OpenAPI fetches) pass through untouched. Each capture mode costs
# different amounts upstream, so the cost lookup is path-aware (see
# `_estimated_cost_for`).
_GUARDED_PATH_PREFIX: Final = "/api/v1/captures"
_VOICE_PATH = "/api/v1/captures/voice"
_PHOTO_PATH = "/api/v1/captures/photo"


class CostCapMiddleware(BaseHTTPMiddleware):
    """Per-IP rate limit + daily spend kill-switch on capture endpoints.

    Three failure modes — distinct error codes so the frontend can show
    differentiated copy:

    - `rate_limited_ip` (429): per-IP minute or hour bucket exceeded.
    - `daily_spend_capped` (429): UTC-day spend total exceeded the cap.

    Constructed once per process; `Lock`-guarded internal state survives
    the lifetime of the process.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        per_minute: int,
        per_hour: int,
        daily_spend_cap_usd: float | None,
    ) -> None:
        super().__init__(app)
        self._per_minute = per_minute
        self._per_hour = per_hour
        self._spend_cap_usd = daily_spend_cap_usd
        self._lock = Lock()
        self._minute_hits: dict[str, deque[float]] = defaultdict(deque)
        self._hour_hits: dict[str, deque[float]] = defaultdict(deque)
        self._spend_today_usd: float = 0.0
        self._spend_day: date = _today_utc()

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.method != "POST" or not request.url.path.startswith(
            _GUARDED_PATH_PREFIX
        ):
            return await call_next(request)

        client_ip = _client_ip(request)
        now = time.monotonic()

        with self._lock:
            self._roll_day_if_needed()

            # Spend cap is the outermost gate — once exceeded, no work
            # gets started today regardless of which IP asks.
            if (
                self._spend_cap_usd is not None
                and self._spend_today_usd >= self._spend_cap_usd
            ):
                return _refuse(
                    code="daily_spend_capped",
                    message=(
                        "We've hit today's safety limit on AI usage. "
                        "Try again after midnight UTC."
                    ),
                    log_extra={
                        "limiter": "daily_spend",
                        "running_total_usd": round(self._spend_today_usd, 4),
                        "cap_usd": self._spend_cap_usd,
                    },
                    retry_after_seconds=_seconds_until_utc_midnight(),
                )

            minute_hits = self._minute_hits[client_ip]
            _drop_older_than(minute_hits, now - 60.0)
            if len(minute_hits) >= self._per_minute:
                return _refuse(
                    code="rate_limited_ip",
                    message="You're moving fast — give it a minute and try again.",
                    log_extra={
                        "limiter": "ip_minute",
                        "client_ip": client_ip,
                        "current": len(minute_hits),
                        "cap": self._per_minute,
                    },
                    retry_after_seconds=60,
                )

            hour_hits = self._hour_hits[client_ip]
            _drop_older_than(hour_hits, now - 3600.0)
            if len(hour_hits) >= self._per_hour:
                return _refuse(
                    code="rate_limited_ip",
                    message="You've hit your hourly limit. Try again later.",
                    log_extra={
                        "limiter": "ip_hour",
                        "client_ip": client_ip,
                        "current": len(hour_hits),
                        "cap": self._per_hour,
                    },
                    retry_after_seconds=3600,
                )

            # Past the gates — record the hit + charge the estimated
            # cost up front. Charging up-front (rather than after the
            # call returns) means a burst of parallel requests can't
            # all sneak past a near-cap spend total by racing.
            minute_hits.append(now)
            hour_hits.append(now)
            self._spend_today_usd += _estimated_cost_for(request.url.path)

        return await call_next(request)

    def _roll_day_if_needed(self) -> None:
        today = _today_utc()
        if today != self._spend_day:
            logger.info(
                "cost_cap.spend_day_rollover",
                extra={
                    "previous_day": self._spend_day.isoformat(),
                    "previous_total_usd": round(self._spend_today_usd, 4),
                },
            )
            self._spend_day = today
            self._spend_today_usd = 0.0


def _estimated_cost_for(path: str) -> float:
    """Pick the per-call cost estimate for the request's path."""
    if path == _VOICE_PATH:
        return _VOICE_COST_USD
    if path == _PHOTO_PATH:
        return _PHOTO_COST_USD
    return _TEXT_COST_USD


def _today_utc() -> date:
    return datetime.now(UTC).date()


def _drop_older_than(buf: deque[float], threshold: float) -> None:
    while buf and buf[0] < threshold:
        buf.popleft()


def _client_ip(request: Request) -> str:
    """Best-effort originating client IP.

    Prefer the leftmost `X-Forwarded-For` entry — proxies append on the
    way in, so the leftmost value is the originating client (with the
    caveat that an attacker can spoof it; trust depends on your proxy
    chain stripping or replacing the header on ingress). Fall back to
    the direct TCP peer if no header is present.
    """
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        first = fwd.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


def _seconds_until_utc_midnight() -> int:
    now = datetime.now(UTC)
    tomorrow = (now.date().toordinal() + 1)
    midnight = datetime.fromordinal(tomorrow).replace(tzinfo=UTC)
    return max(1, int((midnight - now).total_seconds()))


def _refuse(
    *,
    code: str,
    message: str,
    log_extra: dict[str, object],
    retry_after_seconds: int,
) -> JSONResponse:
    logger.warning("cost_cap.refused", extra={"code": code, **log_extra})
    return JSONResponse(
        status_code=429,
        content={"error": {"code": code, "message": message}},
        headers={"Retry-After": str(retry_after_seconds)},
    )
