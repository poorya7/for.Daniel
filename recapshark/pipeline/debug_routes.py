"""Mobile-debug log relay.

Frontend's debug-relay.js posts batched events here when `?debug=1` is on
the URL. Each event is logged to pm2 stdout with a `[CLIENTLOG]` prefix
so the on-call agent can tail and grep them in real-time while the user
reproduces a bug on a device without DevTools access (iOS Safari, etc.).

This is a temporary debug surface, not part of the product API. The
endpoint is auth-gated by the same X-API-Token middleware as everything
else under /api/, but otherwise it accepts any payload — keep it
defensive: rate-limit hard, cap payload sizes, strip control chars before
logging so nothing in a client message can corrupt the log stream.
"""
import logging
import re

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from deps import limiter


logger = logging.getLogger(__name__)
debug_router = APIRouter()


_CTRL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _sanitize(s: str, maxlen: int) -> str:
    """Strip control chars + truncate. Keeps log lines parseable and
    prevents any client-supplied byte from injecting a fake log line."""
    s = _CTRL_CHARS_RE.sub("", s or "")
    if len(s) > maxlen:
        s = s[:maxlen] + "...(truncated)"
    return s


class ClientLogEvent(BaseModel):
    ts: int | None = None         # client wall-clock ms (advisory)
    level: str = "log"            # log | warn | error | uncaught | unhandled | probe
    msg: str = ""
    extra: str | None = None      # pre-stringified extra context


class ClientLogPayload(BaseModel):
    session: str = Field(default="", max_length=32)
    events: list[ClientLogEvent] = Field(default_factory=list)


@debug_router.post("/debug/clientlog")
@limiter.limit("60/minute")
async def clientlog(request: Request, payload: ClientLogPayload):
    session = _sanitize(payload.session, 32)
    # Cap events per request to 20 — frontend batches at 10, give 2x
    # safety margin without letting a single POST log-flood.
    for ev in payload.events[:20]:
        level = _sanitize(ev.level or "log", 12)
        msg = _sanitize(ev.msg or "", 2000)
        extra = ev.extra and _sanitize(ev.extra, 500)
        extra_suffix = f" extra={extra}" if extra else ""
        logger.info(
            "[CLIENTLOG] session=%s level=%s msg=%s%s",
            session, level, msg, extra_suffix,
        )
    return {"ok": True}
