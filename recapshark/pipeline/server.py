"""
RecapShark API Server
Thin entry point: creates the FastAPI app, mounts routes, and serves the frontend.
Run with: uvicorn server:app --host 127.0.0.1 --port 8000
Note: Do NOT use --reload on Windows; it kills background worker threads.
"""

import logging
import os
from pathlib import Path


# Root logging config — Phase 5 baseline. Without this, `logging.getLogger(__name__)`
# in pipeline.* modules inherits the root logger's default WARNING level, so all
# the [KARAOKE-CHUNK] / [TRANSLATE:json] / [GOOGLE-BATCH] info-level lines that
# replaced the old `print(..., flush=True)` calls in Phase 4e would silently drop
# in pm2 logs. Configure once here and every module's logger inherits.
#
# `LOG_LEVEL` env var (default INFO) lets prod tighten / loosen without code
# changes — `LOG_LEVEL=DEBUG pm2 restart recapshark` for an ad-hoc deep-dive.
# `force=True` lets us call basicConfig even if a transitively-imported library
# has already grabbed the root logger.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    force=True,
)


# .env MUST be loaded BEFORE any project-module imports below. Many sub-modules
# (audio_cache.py, asr_provider_routes.py, etc.) read env vars at MODULE LOAD TIME via
# top-level `os.environ.get(...)` calls — if .env is parsed AFTER the imports,
# those reads return empty strings and the module-level constants get silently
# wrong values for the lifetime of the process. This was the root cause of the
# 2026-05-01 lazy-karaoke deploy bug: yt-dlp ran without --cookies (and fell
# through to the bot-blocked anonymous path) because audio_cache.py read
# RECAPSHARK_YT_COOKIES_FILE before .env was loaded. PM2's `/proc/PID/environ`
# does NOT show vars set via `os.environ.setdefault()` (that file is frozen at
# spawn time), so the breakage was invisible to standard env diagnostics.
# `setdefault` (not `[]=`) means an actual shell-environment value still wins
# over the .env value — useful for one-off overrides via `RECAPSHARK_YT_COOKIES_FILE=... pm2 restart`.
_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

from fastapi import FastAPI, Request  # noqa: E402  (.env load must precede project imports)
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from slowapi import _rate_limit_exceeded_handler  # noqa: E402
from slowapi.errors import RateLimitExceeded  # noqa: E402

from config import recapshark_api_token, sentry_dsn_backend  # noqa: E402
from deps import limiter  # noqa: E402
from routes import router  # noqa: E402


logger = logging.getLogger(__name__)


# Initialize Sentry early so unhandled exceptions across all imports below
# are captured. Gated on SENTRY_DSN_BACKEND — empty/missing = SDK no-op (no
# network calls). The try/except means a missing sentry-sdk install logs a
# clear warning instead of crash-looping pm2 — defense in depth for a
# forgotten `pip install -r requirements.txt` after pulling this commit.
_SENTRY_DSN_BACKEND = sentry_dsn_backend()
if _SENTRY_DSN_BACKEND:
    try:
        import sentry_sdk
        sentry_sdk.init(
            dsn=_SENTRY_DSN_BACKEND,
            # Error monitoring only at v1 — no tracing/profiling. Revisit when
            # traffic justifies the volume (Sentry meters traced transactions).
            # send_default_pii defaults to False so IPs / cookies / request
            # bodies aren't shipped — we have no user accounts, no auth
            # context to capture, IP wouldn't help triage karaoke bugs.
            traces_sample_rate=0,
            profiles_sample_rate=0,
        )
        logger.info("[SENTRY] backend SDK initialized")
    except ImportError:
        logger.warning("[SENTRY] sentry-sdk not installed — run pip install -r requirements.txt")
else:
    logger.info("[SENTRY] disabled (SENTRY_DSN_BACKEND not set)")


# Suppress noisy 304 Not Modified and static file logs
class _QuietAccessFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        if "304 Not Modified" in msg:
            return False
        # Suppress static asset requests (css, js, img, fonts, svg)
        if any(ext in msg for ext in [".css ", ".js ", ".png ", ".svg ", ".ico ", ".woff", ".ttf "]):
            return False
        return True

logging.getLogger("uvicorn.access").addFilter(_QuietAccessFilter())

app = FastAPI(title="RecapShark API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DIST_DIR = _PROJECT_ROOT / "dist"
_SRC_DIR = _PROJECT_ROOT / "src"
FRONTEND_DIR = _DIST_DIR if (_DIST_DIR / "index.html").exists() else _SRC_DIR

@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Serve favicon to avoid 404s in logs."""
    path = FRONTEND_DIR / "favicon.svg"
    if not path.exists():
        path = FRONTEND_DIR / "assets" / "favicon.svg"
    if path.exists():
        return FileResponse(path, media_type="image/svg+xml")
    return Response(status_code=204)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://recapshark.com", "https://www.recapshark.com", "http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Simple API token auth — blocks casual abuse (curl/scripts without the token)
_API_TOKEN = recapshark_api_token()

@app.middleware("http")
async def check_api_token(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path != "/api/health" and _API_TOKEN:
        token = request.headers.get("X-API-Token", "")
        if token != _API_TOKEN:
            return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    return await call_next(request)

# Mount API first so /api/* is handled before StaticFiles
app.include_router(router, prefix="/api")
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


# Lazy-karaoke startup smoke-test: verify asr_provider_daily_usage RPCs work
# at startup so a missing migration / stale signature / permission gap
# surfaces immediately in pm2 logs instead of silently breaking the panic
# brake on the first real chunk request. Best-effort — failure logs but
# doesn't crash.
@app.on_event("startup")
async def _lazy_karaoke_startup_check():
    try:
        from karaoke import startup_smoke_test
        await startup_smoke_test()
    except Exception as e:
        # Log but never crash startup — server is still useful for
        # non-karaoke endpoints if anything in the smoke-test breaks.
        logger.warning("[STARTUP] lazy karaoke smoke-test crashed: %s: %s", type(e).__name__, e)


# Phase 5 telemetry: kick off the [KARAOKE-DAILY] day-rollover watchdog as a
# background task on startup. Wakes every 60s, checks if UTC date has rolled
# over since the last logged day, and emits the closed day's summary. The
# log also fires inline on the first chunk request of a new day, so this
# watchdog is a backstop for low-traffic days where no chunk request happens
# until well after midnight. Best-effort — startup never crashes from this.
@app.on_event("startup")
async def _start_karaoke_daily_watchdog():
    import asyncio
    try:
        from karaoke import _daily_log_watchdog
        asyncio.create_task(_daily_log_watchdog())
        logger.info("[STARTUP] [KARAOKE-DAILY] watchdog task scheduled")
    except Exception as e:
        logger.warning("[STARTUP] failed to schedule [KARAOKE-DAILY] watchdog: %s: %s", type(e).__name__, e)
