"""Per-request correlation ID — the load-bearing thread for structured logs.

A request enters; this middleware mints a fresh ID (or honours the
`X-Request-ID` header an upstream proxy set), binds it to the async
context for the duration of the request, and echoes it on the response
so the browser can quote it in support tickets. Every log record
emitted *while the request runs* picks the ID up via `RequestIdFilter`
in `api/logging_config.py`.

Why a `ContextVar` and not a thread-local: `asyncio.Task` propagates
context vars through `await` points by design. Thread-locals would
break the moment a coroutine got rescheduled onto a different worker
thread (which httpx, SQLAlchemy async, and FastAPI's threadpool all
do under the hood).

Why this lives next to the middleware that owns it: the contextvar's
*lifetime* is the dispatch span. Putting it elsewhere invites callers
to read it outside that lifetime, which would silently return `None`
or — worse — a stale ID from a previous request that hasn't reset yet.
The accessor stays here so the layering is obvious.
"""

from __future__ import annotations

import contextvars
import uuid
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# Default `None` so a log call outside a request context (e.g. during
# app startup, a background task that didn't bind one) still works —
# the filter just renders `request_id="-"` for those records.
_request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "captureshark_request_id",
    default=None,
)

# Inbound header name (lowercased — Starlette normalises).
_INBOUND_HEADER = "x-request-id"
# Outbound header name (canonical casing for the wire).
_OUTBOUND_HEADER = "X-Request-ID"


def current_request_id() -> str | None:
    """Read the bound request ID for the current async context.

    Returns `None` outside a request scope. The logging filter coerces
    that to `"-"` so log lines stay shape-consistent.
    """
    return _request_id_var.get()


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Bind an `X-Request-ID` to the request's async context.

    Honours an inbound `X-Request-ID` if the upstream sent one (so a
    load balancer can tag a request once and have every downstream
    service log under the same ID); otherwise mints a fresh `uuid4().hex`.
    Always echoes on the response.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request_id = request.headers.get(_INBOUND_HEADER) or uuid.uuid4().hex
        token = _request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            _request_id_var.reset(token)
        response.headers[_OUTBOUND_HEADER] = request_id
        return response
