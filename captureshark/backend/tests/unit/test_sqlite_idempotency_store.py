"""Unit tests for `adapters/sqlite_idempotency_store.SqliteIdempotencyStore`.

The contract these tests pin (from plan §7):

  1. After `record`, a `lookup` with the same `(key, user_id)` returns
     the same response. (The whole point of the store.)
  2. A `lookup` with a different `user_id` than the recorder returns
     `None`, never the cached response — cross-user replay is
     blocked at the storage layer.
  3. A `lookup` for a row past its `expires_at` returns `None`, even
     before `sweep_expired` runs. Correctness can't depend on sweep
     timing.
  4. Recording the same key twice does NOT raise — the first write
     wins, the second is a no-op. Concurrent retries that both
     reach `record` are a real race; the adapter has to swallow it.
  5. `sweep_expired(now)` deletes every row whose `expires_at` is
     at or before `now`, and reports the count.

Real SQLite (file-backed, per-test tmp_path) so the schema behaviour
matches production. Tests run in <1s.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Importing the orm modules is what registers their tables on
# `Base.metadata`; the explicit import here is what makes
# `create_all` create the `idempotency_keys` table.
from captureshark.adapters import idempotency_orm  # noqa: F401 — registers table
from captureshark.adapters.orm import UserRow
from captureshark.adapters.sqlite_idempotency_store import SqliteIdempotencyStore
from captureshark.db.base import Base
from captureshark.domain.idempotency import CachedResponse


# --- Fixtures -------------------------------------------------------------


@pytest_asyncio.fixture
async def engine(tmp_path: Path) -> AsyncGenerator[AsyncEngine, None]:
    """File-backed SQLite per test — schema parity with prod, isolation per test."""
    db_file = tmp_path / "test.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file.as_posix()}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def session_factory(
    engine: AsyncEngine,
) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def two_user_ids(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[int, int]:
    """Insert two users so the FK on `idempotency_keys.user_id` resolves
    for the cross-user-replay test."""
    async with session_factory.begin() as session:
        a = UserRow(google_user_id="sub-a", email="a@example.com", name=None, picture_url=None)
        b = UserRow(google_user_id="sub-b", email="b@example.com", name=None, picture_url=None)
        session.add(a)
        session.add(b)
        await session.flush()
        return (a.id, b.id)


def _future(seconds: int = 60) -> datetime:
    return datetime.now(UTC) + timedelta(seconds=seconds)


def _past(seconds: int = 60) -> datetime:
    return datetime.now(UTC) - timedelta(seconds=seconds)


# --- Tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_lookup_returns_recorded_response(
    session_factory: async_sessionmaker[AsyncSession],
    two_user_ids: tuple[int, int],
) -> None:
    """Round-trip: record then lookup returns the same cached response."""
    user_id, _ = two_user_ids
    store = SqliteIdempotencyStore(session_factory=session_factory)
    payload = CachedResponse(status=200, body_json='{"target":{"spreadsheet_id":"abc"}}')

    await store.record(
        key="capture-uuid-1",
        user_id=user_id,
        response=payload,
        expires_at=_future(),
    )
    loaded = await store.lookup("capture-uuid-1", user_id=user_id)

    assert loaded == payload


@pytest.mark.asyncio
async def test_lookup_misses_when_key_unseen(
    session_factory: async_sessionmaker[AsyncSession],
    two_user_ids: tuple[int, int],
) -> None:
    """A key the store has never seen → None, no exception."""
    user_id, _ = two_user_ids
    store = SqliteIdempotencyStore(session_factory=session_factory)

    loaded = await store.lookup("never-seen", user_id=user_id)

    assert loaded is None


@pytest.mark.asyncio
async def test_cross_user_replay_is_blocked(
    session_factory: async_sessionmaker[AsyncSession],
    two_user_ids: tuple[int, int],
) -> None:
    """User A's cached response is invisible to user B even on a key match.

    Defence-in-depth against uuid collisions and adversarial key replay.
    """
    user_a, user_b = two_user_ids
    store = SqliteIdempotencyStore(session_factory=session_factory)
    payload = CachedResponse(status=200, body_json='{"target":{"spreadsheet_id":"abc"}}')

    await store.record(
        key="shared-uuid",
        user_id=user_a,
        response=payload,
        expires_at=_future(),
    )
    loaded = await store.lookup("shared-uuid", user_id=user_b)

    assert loaded is None


@pytest.mark.asyncio
async def test_expired_row_is_treated_as_miss(
    session_factory: async_sessionmaker[AsyncSession],
    two_user_ids: tuple[int, int],
) -> None:
    """A row past its `expires_at` returns None even before the sweep.

    The lookup does its own expiry check; sweep is just storage hygiene.
    """
    user_id, _ = two_user_ids
    store = SqliteIdempotencyStore(session_factory=session_factory)

    await store.record(
        key="aged-out",
        user_id=user_id,
        response=CachedResponse(status=200, body_json="{}"),
        expires_at=_past(),
    )
    loaded = await store.lookup("aged-out", user_id=user_id)

    assert loaded is None


@pytest.mark.asyncio
async def test_recording_same_key_twice_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
    two_user_ids: tuple[int, int],
) -> None:
    """A second `record` for the same key does not raise.

    Two concurrent retries can both reach the record path before
    either has persisted; both responses are equivalent (same logical
    save), so the first write wins and the second silently no-ops.
    """
    user_id, _ = two_user_ids
    store = SqliteIdempotencyStore(session_factory=session_factory)
    first = CachedResponse(status=200, body_json='{"target":{"spreadsheet_id":"abc"}}')
    second = CachedResponse(status=200, body_json='{"target":{"spreadsheet_id":"xyz"}}')

    await store.record(
        key="race-key",
        user_id=user_id,
        response=first,
        expires_at=_future(),
    )
    # Second call should NOT raise.
    await store.record(
        key="race-key",
        user_id=user_id,
        response=second,
        expires_at=_future(),
    )

    # First write wins.
    loaded = await store.lookup("race-key", user_id=user_id)
    assert loaded == first


@pytest.mark.asyncio
async def test_sweep_expired_deletes_only_aged_rows(
    session_factory: async_sessionmaker[AsyncSession],
    two_user_ids: tuple[int, int],
) -> None:
    """`sweep_expired(now)` removes only rows past their TTL."""
    user_id, _ = two_user_ids
    store = SqliteIdempotencyStore(session_factory=session_factory)

    await store.record(
        key="fresh",
        user_id=user_id,
        response=CachedResponse(status=200, body_json="{}"),
        expires_at=_future(),
    )
    await store.record(
        key="aged-1",
        user_id=user_id,
        response=CachedResponse(status=200, body_json="{}"),
        expires_at=_past(),
    )
    await store.record(
        key="aged-2",
        user_id=user_id,
        response=CachedResponse(status=200, body_json="{}"),
        expires_at=_past(seconds=3600),
    )

    deleted = await store.sweep_expired(datetime.now(UTC))

    assert deleted == 2
    # Fresh row survives.
    assert await store.lookup("fresh", user_id=user_id) is not None
