"""SQLAlchemy-backed implementation of `IdempotencyStorePort`.

Stores client-supplied idempotency keys + the responses we returned
the first time, so that retries of the same logical save replay the
cached response instead of re-running the Sheets write. This is the
backstop that prevents the offline-resilient queue (plan §7) from
silently duplicating rows when a retry follows an ambiguous failure.

Persistence is SQLite, NOT in-memory: the reviewer passes were
emphatic that a server restart cannot lose the key set, or every
deploy becomes a duplicate-row event for any user whose retry
crosses the restart boundary.

Scoping: keys are keyed by `key` (the uuid the client sent) but
lookups always cross-check `user_id`. A cross-user replay (two
users somehow colliding on a uuid v4 — astronomically unlikely
but bounded by adversarial assumptions) is treated as a cache miss.

Expiry: rows carry an absolute `expires_at`. `lookup` ignores rows
past their TTL even if `sweep_expired` hasn't run yet, so correctness
doesn't depend on sweep timing. The sweep is just a storage-hygiene
nicety — old keys would otherwise accumulate forever.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from captureshark.adapters.idempotency_orm import IdempotencyKeyRow
from captureshark.domain.idempotency import CachedResponse, IdempotencyStorePort


class SqliteIdempotencyStore(IdempotencyStorePort):
    """Async SQLite implementation of the idempotency store."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def lookup(
        self,
        key: str,
        user_id: int,
    ) -> CachedResponse | None:
        """Return the cached response for `(key, user_id)`, or `None`.

        Cache misses include:
          * The key has never been seen.
          * The key exists but is scoped to a different user.
          * The key exists, scoped correctly, but has expired —
            treat as miss so the save runs fresh. The expired row
            will be cleaned up by the next `sweep_expired`.
        """
        async with self._session_factory() as db:
            row = await db.scalar(
                select(IdempotencyKeyRow).where(IdempotencyKeyRow.key == key)
            )
            if row is None:
                return None
            if row.user_id != user_id:
                return None
            if row.expires_at <= datetime.now(UTC):
                return None
            return CachedResponse(
                status=row.cached_status,
                body_json=row.cached_body_json,
            )

    async def record(
        self,
        key: str,
        user_id: int,
        response: CachedResponse,
        expires_at: datetime,
    ) -> None:
        """Persist `response` against `(key, user_id)`.

        Defensive against the same key being recorded twice in quick
        succession (two concurrent retries that both reached us
        before either persisted). The second insert's
        `IntegrityError` is swallowed — by definition the first
        write's response is the canonical one to replay, and both
        responses are equivalent anyway because they came from the
        same logical save.
        """
        async with self._session_factory.begin() as db:
            row = IdempotencyKeyRow(
                key=key,
                user_id=user_id,
                cached_status=response.status,
                cached_body_json=response.body_json,
                expires_at=expires_at,
            )
            db.add(row)
            try:
                await db.flush()
            except IntegrityError:
                # Already recorded (concurrent retry won the race).
                # The existing row is, by construction, the response
                # we'd have written — replay it next time instead.
                await db.rollback()

    async def sweep_expired(self, now: datetime) -> int:
        """Delete all rows whose `expires_at <= now`.

        Returns the count deleted so the caller (lifespan hook /
        periodic task) can log how much it reclaimed. Cheap thanks
        to the `expires_at` index.
        """
        async with self._session_factory.begin() as db:
            result = await db.execute(
                delete(IdempotencyKeyRow).where(IdempotencyKeyRow.expires_at <= now)
            )
            return int(result.rowcount or 0)
