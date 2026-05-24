"""Alembic runtime — wires our typed `Settings` and ORM `Base` to migrations.

The runtime driver is async (`sqlite+aiosqlite`), but Alembic migrations
are one-shot batch operations that don't benefit from async; we derive a
sync-driver URL here so the migration script can use SQLAlchemy's stable
sync execution path. This avoids the pitfalls of running Alembic's
DDL-emitting code under an event loop.

Importing `captureshark.adapters.orm` is what registers every ORM model
on `Base.metadata`; without that import, `--autogenerate` would emit an
empty diff.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from captureshark.config import get_settings
from captureshark.db.base import Base

# Importing the ORM module registers every table on `Base.metadata`. The
# `noqa: F401` is intentional — the import is for its side effect, not
# for any name we use directly here.
from captureshark.adapters import orm  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _sync_database_url() -> str:
    """Return a sync-driver URL for Alembic from the project settings.

    Settings hold the runtime URL (typically async). We swap the async
    driver for its sync sibling so Alembic's blocking code path works
    without spinning up an event loop. Other URLs pass through.
    """
    url = get_settings().resolved_database_url
    return url.replace("sqlite+aiosqlite://", "sqlite://", 1)


def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting — useful for review / CI."""
    context.configure(
        url=_sync_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # SQLite needs batch mode for ALTER TABLE; harmless on Postgres.
        render_as_batch=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against the live database."""
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _sync_database_url()

    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
