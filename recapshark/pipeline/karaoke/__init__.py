"""
Karaoke / word-level subtitle alignment subpackage.

The full implementation is intentionally withheld from this code-review
sample — chunked transcription with cost-aware billing, range-fetched
audio backfill, single-flight chunk dedup. It's the project's main
differentiator and isn't shared externally.

Only the FastAPI router stub remains so `server.py` and the rest of the
pipeline import cleanly. All endpoints respond 501 Not Implemented at
runtime. The lifecycle hooks (`startup_smoke_test`, `_daily_log_watchdog`)
keep the same signatures so the boot sequence works unmodified.
"""

from .routes import asr_provider_router


async def startup_smoke_test() -> None:
    """No-op in the code-review sample."""
    return None


async def _daily_log_watchdog() -> None:
    """No-op in the code-review sample."""
    return None


__all__ = ["asr_provider_router", "startup_smoke_test", "_daily_log_watchdog"]
