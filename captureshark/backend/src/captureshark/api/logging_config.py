"""Process-wide logging setup — JSON output + per-request correlation ID.

Called once at app startup from `main.create_app()`. Reconfigures the
root logger so:

  * Every log record is rendered as a single JSON object on stdout
    (one line, no newlines inside) — what aggregators like Datadog,
    CloudWatch, and Loki expect to ingest losslessly.
  * Every record carries the bound `request_id` from
    `api/middleware/request_id`, so a real user's full request trail
    can be reconstructed from logs alone.
  * Records emitted outside a request scope (startup, background
    tasks) get `request_id="-"` so the field shape stays uniform.

Module-name loggers (`logging.getLogger(__name__)`) propagate to root
unchanged — this module does not require call-sites to switch loggers.
Existing `logger.warning(...)` calls keep working; they just emit JSON
now. Calls that pass `extra={"key": value}` get those keys merged into
the JSON object as top-level fields, which is the format the audit pass
in §3 converts call-sites toward.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Final

from pythonjsonlogger.json import JsonFormatter

from captureshark.api.middleware.request_id import current_request_id

# Persistent log file — in addition to stdout. Lets an operator (or
# Claude during a debug session) read past records without depending on
# the uvicorn terminal's scrollback. Path is under `backend/logs/`,
# which is already gitignored (`*.log` + `logs/` rules in .gitignore).
_LOG_FILE_PATH: Final = (
    Path(__file__).resolve().parents[3] / "logs" / "captureshark.log"
)

# Field-name aliases on the wire. Internal `logging` names are not what
# downstream aggregators expect; rename at the boundary.
_FIELD_RENAMES: Final[dict[str, str]] = {
    "asctime": "timestamp",
    "levelname": "level",
    "name": "logger",
}

# Format string — drives which `LogRecord` fields the formatter emits.
# Order doesn't matter for JSON output, but keeping `message` last
# matches how text-formatted logs read.
_FMT: Final = "%(asctime)s %(levelname)s %(name)s %(request_id)s %(message)s"


class RequestIdFilter(logging.Filter):
    """Inject the active request_id (or `"-"`) onto every record.

    A `Filter` rather than custom `Formatter` because the request_id
    needs to be available to *any* formatter that reads it — including
    the JSON formatter, but also any future text formatter we might
    enable for local dev. Filters run before formatters; this is the
    cleanest seam.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = current_request_id() or "-"
        return True


def configure_logging(*, level: int = logging.INFO) -> None:
    """Install JSON output + the request_id filter on the root logger.

    Idempotent: re-running replaces the handlers rather than appending,
    so calling this from a hot-reloading test or a worker process that
    re-imports `main` won't pile up duplicate handlers.

    Why root rather than per-module: every `logging.getLogger(__name__)`
    in the codebase propagates to root by default. Configuring at root
    means new modules pick up JSON output for free — no per-module
    handler dance, no chance of a forgotten `getLogger()` skipping the
    formatter.
    """
    formatter = JsonFormatter(
        fmt=_FMT,
        rename_fields=_FIELD_RENAMES,
        timestamp=True,
    )
    request_id_filter = RequestIdFilter()

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(formatter)
    stdout_handler.addFilter(request_id_filter)

    # Mirror everything to a persistent file so past records survive
    # the terminal scrollback. Same JSON format / same filter.
    _LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(_LOG_FILE_PATH, encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.addFilter(request_id_filter)

    root = logging.getLogger()
    root.handlers = [stdout_handler, file_handler]
    root.setLevel(level)

    # Also pin the level on the noisy uvicorn/httpx loggers so a stray
    # DEBUG flag in a sub-library doesn't flood production. They still
    # propagate to root and pick up the JSON formatter.
    for noisy_name in ("httpx", "httpcore", "openai"):
        logging.getLogger(noisy_name).setLevel(logging.WARNING)
