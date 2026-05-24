"""Unit tests for `adapters/sqlite_token_store.SqliteTokenStore`.

This is the *only* code in the project that touches plaintext OAuth
tokens AND their on-disk ciphertext form. The contract these tests
pin:

  1. After `save_for_user`, the bytes in the DB row do NOT contain
     either token's plaintext substring. A leaked DB file alone must
     not be enough to act on behalf of any user.
  2. `get_for_user` round-trips losslessly — the returned plaintext
     equals what was saved, including the granted-scopes set.
  3. A row written with key A then read with key B raises a clear
     `RuntimeError` (not a silent `None`, not a generic crash). Key
     rotation requires a re-encryption migration; the operator must
     see the failure rather than have us return "no tokens" and
     forcibly re-auth every user.

Real Fernet, real SQLite (in-memory file-backed so the schema
behaves the same way it would in dev). Tests run in <1s.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path

import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from captureshark.adapters.orm import OAuthTokenRow, UserRow
from captureshark.adapters.sqlite_token_store import SqliteTokenStore
from captureshark.db.base import Base
from captureshark.domain.auth import OAuthTokens

# --- Test fixtures --------------------------------------------------------

_PLAINTEXT_ACCESS = "ACCESS-TOKEN-secret-do-not-leak"
_PLAINTEXT_REFRESH = "REFRESH-TOKEN-secret-must-stay-server-side"


@pytest_asyncio.fixture
async def engine(tmp_path: Path) -> AsyncGenerator[AsyncEngine, None]:
    """File-backed SQLite at a tmp path so each test gets a fresh DB.

    File-backed (not `:memory:`) so concurrent connections see the
    same data — matches dev / prod semantics.
    """
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
async def user_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> int:
    """Insert a user so the FK on `oauth_tokens.user_id` resolves."""
    async with session_factory.begin() as session:
        user = UserRow(
            google_user_id="google-sub-test",
            email="test@example.com",
            name="Test User",
            picture_url=None,
        )
        session.add(user)
        await session.flush()
        return user.id


def _make_tokens() -> OAuthTokens:
    return OAuthTokens(
        access_token=_PLAINTEXT_ACCESS,
        refresh_token=_PLAINTEXT_REFRESH,
        access_token_expires_at=datetime(2026, 5, 10, 15, 30, tzinfo=UTC),
        granted_scopes=frozenset({"openid", "email", "https://www.googleapis.com/auth/drive.file"}),
    )


# --- Tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_persisted_row_does_not_contain_access_token_plaintext(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: int,
) -> None:
    """A leaked DB row must not reveal the access token."""
    fernet = Fernet(Fernet.generate_key())
    store = SqliteTokenStore(session_factory=session_factory, fernet=fernet)

    await store.save_for_user(user_id, _make_tokens())

    raw = await _read_raw_row(session_factory, user_id)
    assert _PLAINTEXT_ACCESS not in raw["access_token_ciphertext"]
    assert _PLAINTEXT_ACCESS not in raw["refresh_token_ciphertext"]


@pytest.mark.asyncio
async def test_persisted_row_does_not_contain_refresh_token_plaintext(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: int,
) -> None:
    """Same guarantee for the refresh token — Apple-grade rule:
    refresh tokens never leave the server, so they MUST be opaque
    even to someone holding the DB file."""
    fernet = Fernet(Fernet.generate_key())
    store = SqliteTokenStore(session_factory=session_factory, fernet=fernet)

    await store.save_for_user(user_id, _make_tokens())

    raw = await _read_raw_row(session_factory, user_id)
    assert _PLAINTEXT_REFRESH not in raw["access_token_ciphertext"]
    assert _PLAINTEXT_REFRESH not in raw["refresh_token_ciphertext"]


@pytest.mark.asyncio
async def test_round_trip_preserves_plaintext_and_scopes(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: int,
) -> None:
    """save → get round-trips losslessly: plaintext + scopes intact."""
    fernet = Fernet(Fernet.generate_key())
    store = SqliteTokenStore(session_factory=session_factory, fernet=fernet)
    original = _make_tokens()

    await store.save_for_user(user_id, original)
    loaded = await store.get_for_user(user_id)

    assert loaded is not None
    assert loaded.access_token == original.access_token
    assert loaded.refresh_token == original.refresh_token
    assert loaded.access_token_expires_at == original.access_token_expires_at
    assert loaded.granted_scopes == original.granted_scopes


@pytest.mark.asyncio
async def test_save_then_save_overwrites_in_place(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: int,
) -> None:
    """Re-authorising the same user updates the row, doesn't duplicate.

    Important because the FK from sessions/sheet_connections expects
    one tokens row per user — duplicating would violate the unique
    constraint on user_id.
    """
    fernet = Fernet(Fernet.generate_key())
    store = SqliteTokenStore(session_factory=session_factory, fernet=fernet)

    first = _make_tokens()
    await store.save_for_user(user_id, first)

    second = OAuthTokens(
        access_token="NEW-ACCESS",
        refresh_token="NEW-REFRESH",
        access_token_expires_at=datetime(2026, 5, 10, 16, 30, tzinfo=UTC),
        granted_scopes=frozenset({"openid"}),
    )
    await store.save_for_user(user_id, second)

    loaded = await store.get_for_user(user_id)
    assert loaded is not None
    assert loaded.access_token == "NEW-ACCESS"
    assert loaded.refresh_token == "NEW-REFRESH"
    assert loaded.granted_scopes == frozenset({"openid"})


@pytest.mark.asyncio
async def test_get_for_user_returns_none_when_absent(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: int,
) -> None:
    """No row → None, not an exception."""
    fernet = Fernet(Fernet.generate_key())
    store = SqliteTokenStore(session_factory=session_factory, fernet=fernet)
    loaded = await store.get_for_user(user_id)
    assert loaded is None


@pytest.mark.asyncio
async def test_wrong_encryption_key_raises_runtime_error(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: int,
) -> None:
    """Save with key A, read with key B → RuntimeError, NOT silent None.

    Silent fallback would force every user to re-auth on a key rotation
    that should have been handled by a re-encryption migration. The
    operator needs to see this loudly so they can choose to migrate
    rather than wipe sessions.
    """
    key_a = Fernet.generate_key()
    key_b = Fernet.generate_key()
    assert key_a != key_b  # sanity

    saver = SqliteTokenStore(session_factory=session_factory, fernet=Fernet(key_a))
    reader = SqliteTokenStore(session_factory=session_factory, fernet=Fernet(key_b))

    await saver.save_for_user(user_id, _make_tokens())

    with pytest.raises(RuntimeError, match="Fernet"):
        await reader.get_for_user(user_id)


# --- Helpers --------------------------------------------------------------


async def _read_raw_row(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: int,
) -> dict[str, str]:
    """Pull the raw ciphertext columns straight from the DB, bypassing
    the store's decrypt path. Used by the leak tests to assert the
    on-disk bytes don't carry the plaintext."""
    from sqlalchemy import select

    async with session_factory() as session:
        row = await session.scalar(
            select(OAuthTokenRow).where(OAuthTokenRow.user_id == user_id)
        )
        assert row is not None
        return {
            "access_token_ciphertext": row.access_token_ciphertext,
            "refresh_token_ciphertext": row.refresh_token_ciphertext,
        }
