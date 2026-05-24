"""SQLAlchemy-backed implementation of `UserRepoPort`.

Owns the async sessionmaker; opens a fresh session per public call so
each method is its own transaction. Tests can pass a sessionmaker
bound to an in-memory SQLite engine without monkey-patching.

Conversion happens at the boundary: `UserRow` (ORM) → `User` (domain).
The domain `User` is a frozen dataclass so it can't accidentally mutate
a row that's still attached to a session.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from captureshark.adapters.orm import UserRow
from captureshark.domain.auth import User, UserRepoPort


class SqliteUserRepo(UserRepoPort):
    """Async SQLite implementation. Works with any SQLAlchemy backend."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def find_by_google_id(self, google_user_id: str) -> User | None:
        async with self._session_factory() as session:
            row = await session.scalar(
                select(UserRow).where(UserRow.google_user_id == google_user_id)
            )
            return _row_to_domain(row) if row is not None else None

    async def get_by_id(self, user_id: int) -> User | None:
        async with self._session_factory() as session:
            row = await session.get(UserRow, user_id)
            return _row_to_domain(row) if row is not None else None

    async def upsert_from_google(
        self,
        *,
        google_user_id: str,
        email: str,
        name: str | None,
        picture_url: str | None,
    ) -> User:
        async with self._session_factory.begin() as session:
            row = await session.scalar(
                select(UserRow).where(UserRow.google_user_id == google_user_id)
            )
            if row is None:
                row = UserRow(
                    google_user_id=google_user_id,
                    email=email,
                    name=name,
                    picture_url=picture_url,
                )
                session.add(row)
                # Flush so `row.id` is populated for the domain object we
                # hand back. Commit happens at the end of the `begin()`
                # context — flushing here is metadata-only.
                await session.flush()
            else:
                row.email = email
                row.name = name
                row.picture_url = picture_url
                row.updated_at = datetime.now(UTC)
                await session.flush()
            return _row_to_domain(row)


def _row_to_domain(row: UserRow) -> User:
    return User(
        id=row.id,
        google_user_id=row.google_user_id,
        email=row.email,
        name=row.name,
        picture_url=row.picture_url,
    )
