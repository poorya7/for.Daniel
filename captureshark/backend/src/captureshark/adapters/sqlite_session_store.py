"""SQLAlchemy-backed implementation of `SessionStorePort`.

Sessions are server-side records the HttpOnly cookie addresses by id.
The cookie itself carries an itsdangerous-signed copy of `Session.id`;
verifying the signature is the API layer's job. Once the signature
checks out, this adapter is the source of truth — `delete()` revokes
instantly because the next lookup fails.

Session ids are 48 random bytes encoded urlsafe-base64 (~64 chars).
That's well above the OWASP-recommended 128 bits of entropy; even a
botnet brute-forcing the table would need geological time. Generated
inside the adapter so callers can't accidentally pass a low-entropy
id.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from captureshark.adapters.orm import SessionRow
from captureshark.domain.auth import Session, SessionStorePort


# 48 raw bytes → ~64 character urlsafe-base64 string. Above the OWASP
# 128-bit entropy floor by a wide margin; cheap on storage either way.
_SESSION_ID_BYTES = 48


class SqliteSessionStore(SessionStorePort):
    """Async SQLite implementation of the session store."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create(
        self,
        *,
        user_id: int,
        user_agent: str | None,
        ip_address: str | None,
    ) -> Session:
        session_id = secrets.token_urlsafe(_SESSION_ID_BYTES)
        async with self._session_factory.begin() as db:
            row = SessionRow(
                id=session_id,
                user_id=user_id,
                user_agent=user_agent,
                ip_address=ip_address,
            )
            db.add(row)
            await db.flush()
            return _row_to_domain(row)

    async def get(self, session_id: str) -> Session | None:
        async with self._session_factory() as db:
            row = await db.scalar(
                select(SessionRow).where(SessionRow.id == session_id)
            )
            return _row_to_domain(row) if row is not None else None

    async def touch(self, session_id: str) -> None:
        async with self._session_factory.begin() as db:
            await db.execute(
                update(SessionRow)
                .where(SessionRow.id == session_id)
                .values(last_seen_at=datetime.now(UTC))
            )

    async def delete(self, session_id: str) -> None:
        async with self._session_factory.begin() as db:
            row = await db.scalar(
                select(SessionRow).where(SessionRow.id == session_id)
            )
            if row is not None:
                await db.delete(row)


def _row_to_domain(row: SessionRow) -> Session:
    return Session(
        id=row.id,
        user_id=row.user_id,
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        user_agent=row.user_agent,
        ip_address=row.ip_address,
    )
