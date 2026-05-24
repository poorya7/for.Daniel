"""Async SQLAlchemy engine + session-factory construction.

Why factories instead of module-level globals: tests need to spin up a
throwaway in-memory DB per test without the production engine being
already cached. The auth service receives an `async_sessionmaker` via DI
and asks for a fresh `AsyncSession` per request — the standard pattern.

In production, `api/deps.py` calls `create_engine_from_settings` once
(memoised via `lru_cache`) so the connection pool is shared across
requests. Tests bypass that cache and pass a fake factory directly.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from captureshark.config import Settings


def create_engine_from_settings(settings: Settings) -> AsyncEngine:
    """Build the async engine for the configured database URL.

    For SQLite, ensures the parent directory of the database file exists
    before SQLAlchemy tries to open it — otherwise `sqlite3` on Windows
    raises a confusing `unable to open database file` error if the
    `backend/data/` folder hasn't been created yet.
    """
    url = settings.resolved_database_url
    _ensure_sqlite_directory(url)
    # `pool_pre_ping=True` validates connections on checkout — cheap on
    # SQLite, prevents stale-connection errors when a Postgres in prod
    # gets bounced. `future=True` is the SQLAlchemy 2.x default but
    # spelled explicitly so behaviour is grep-able.
    return create_async_engine(url, pool_pre_ping=True, future=True)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Build the async sessionmaker bound to the given engine.

    `expire_on_commit=False` matches FastAPI's request-scoped pattern:
    the response serialiser runs *after* the session commits, and would
    otherwise hit detached-instance errors when reading attributes from
    just-committed rows.
    """
    return async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )


def _ensure_sqlite_directory(url: str) -> None:
    """Create the parent directory for a SQLite file URL if missing.

    No-op for non-SQLite URLs (Postgres, MySQL, in-memory `sqlite://`).
    """
    if not url.startswith("sqlite+aiosqlite:///") and not url.startswith("sqlite:///"):
        return
    # Strip the scheme to get the filesystem path. `sqlite+aiosqlite:///`
    # is 3 slashes (relative) or 4 (absolute) — by the time we see it
    # here, `Settings.resolved_database_url` has already absolutised any
    # relative sqlite path, so we just split on `:///`.
    _, _, path_str = url.partition(":///")
    if path_str in ("", ":memory:"):
        return
    Path(path_str).parent.mkdir(parents=True, exist_ok=True)
