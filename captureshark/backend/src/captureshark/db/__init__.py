"""Database layer — SQLAlchemy async engine, sessionmaker, declarative base.

The persistence boundary for CaptureShark. Owns:

- the async engine (one per process, built from `Settings.resolved_database_url`)
- the async session factory (`AsyncSessionLocal`)
- the declarative `Base` ORM models inherit from

Domain code never imports anything from this package — only adapters do.
The split keeps `domain/` portable across storage backends (SQLite for dev,
Postgres for prod, in-memory fakes for tests) without leaking SQLAlchemy
types into pure business logic.
"""

from captureshark.db.base import Base
from captureshark.db.engine import (
    create_engine_from_settings,
    create_session_factory,
)

__all__ = [
    "Base",
    "create_engine_from_settings",
    "create_session_factory",
]
