"""FastAPI application entry point.

This module is intentionally small. Its only jobs are:
  1. Configure structured logging (JSON output + per-request correlation).
  2. Construct the `FastAPI` app with cross-cutting middleware.
  3. Mount the routers from `api/routes/`.
  4. Tear down long-lived resources (DB engine, HTTP client) cleanly
     on process shutdown via a lifespan context manager.

Business logic lives in services; routers are thin shims; this file is the
composition root.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from captureshark.api.deps import (
    _build_engine_cached,
    _build_oauth_http_client_cached,
)
from captureshark.api.logging_config import configure_logging
from captureshark.api.middleware.cost_cap import CostCapMiddleware
from captureshark.api.middleware.request_id import RequestIDMiddleware
from captureshark.api.routes import (
    auth,
    captures,
    client_errors,
    features,
    health,
    live_captions,
    live_captions_telemetry,
    sheets,
)
from captureshark.config import Settings, get_settings


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Dispose long-lived resources on shutdown.

    Acquired lazily on first request via `lru_cache`d factories in
    `api/deps.py`. We only need to *close* them here — startup is a
    no-op because nothing is built until the first request actually
    touches it.
    """
    try:
        yield
    finally:
        settings = get_settings()
        # Don't materialise the engine / client just to close them —
        # the cache hit returns whatever was built (if anything).
        engine = _build_engine_cached.cache_info().currsize and _build_engine_cached(
            settings.resolved_database_url
        )
        if engine:
            await engine.dispose()
        client = (
            _build_oauth_http_client_cached.cache_info().currsize
            and _build_oauth_http_client_cached()
        )
        if client:
            await client.aclose()


def create_app() -> FastAPI:
    """Application factory — keeps test setup clean and avoids import-time side effects."""
    configure_logging()
    settings = get_settings()

    app = FastAPI(
        title="CaptureShark API",
        version=settings.app_version,
        description="Backend service for CaptureShark — AI extraction + Google Sheets routing.",
        docs_url="/docs",
        redoc_url=None,
        openapi_url="/openapi.json",
        lifespan=_lifespan,
    )

    # Middleware ordering matters: outermost runs first on the way in,
    # last on the way out. The request-ID binder needs to run before
    # any logging-emitting middleware (CORS preflights, route handlers,
    # error handlers) so every log line tied to this request carries
    # the correlation ID. Adding it last in code = outermost on the wire.
    #
    # Cost cap sits between request-ID and the routes — refusals still
    # log under the request's correlation ID, but bots don't burn a
    # CORS roundtrip just to be told no.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )
    app.add_middleware(
        CostCapMiddleware,
        per_minute=settings.rate_limit_per_minute,
        per_hour=settings.rate_limit_per_hour,
        daily_spend_cap_usd=settings.daily_openai_spend_cap_usd,
    )
    app.add_middleware(RequestIDMiddleware)

    _log_cost_cap_status(settings)

    # Mount feature routers under the versioned API prefix.
    app.include_router(health.router, prefix=settings.api_prefix)
    app.include_router(features.router, prefix=settings.api_prefix)
    app.include_router(captures.router, prefix=settings.api_prefix)
    app.include_router(live_captions.router, prefix=settings.api_prefix)
    app.include_router(live_captions_telemetry.router, prefix=settings.api_prefix)
    app.include_router(sheets.router, prefix=settings.api_prefix)
    app.include_router(auth.router, prefix=settings.api_prefix)
    app.include_router(client_errors.router, prefix=settings.api_prefix)

    return app


def _log_cost_cap_status(settings: Settings) -> None:
    """Surface the active cost-cap configuration at startup.

    A production boot without an explicit `daily_openai_spend_cap_usd`
    is the most expensive footgun in the system — log it loudly so
    nobody misses it during deploy review.
    """
    log = logging.getLogger(__name__)
    if (
        settings.environment == "production"
        and settings.daily_openai_spend_cap_usd is None
    ):
        log.warning(
            "cost_cap.startup.no_spend_cap_in_production",
            extra={
                "rate_limit_per_minute": settings.rate_limit_per_minute,
                "rate_limit_per_hour": settings.rate_limit_per_hour,
            },
        )
    else:
        log.info(
            "cost_cap.startup",
            extra={
                "environment": settings.environment,
                "rate_limit_per_minute": settings.rate_limit_per_minute,
                "rate_limit_per_hour": settings.rate_limit_per_hour,
                "daily_spend_cap_usd": settings.daily_openai_spend_cap_usd,
            },
        )


app = create_app()
