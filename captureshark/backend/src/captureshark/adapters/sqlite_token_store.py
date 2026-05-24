"""SQLAlchemy + Fernet-backed implementation of `TokenStorePort`.

This adapter is the **only** code in the project that handles plaintext
Google tokens *and* their on-disk ciphertext form. Services hand it
plain `OAuthTokens`; it Fernet-encrypts before SQL, decrypts before
returning. A leaked DB file alone is therefore not enough to act on
behalf of any user — the attacker also needs `TOKEN_ENCRYPTION_KEY`
from `.env`.

Granted scopes are stored as a space-separated string (RFC 6749 §3.3
canonical form) — easy to grep, sort-agnostic on the way out.
"""

from __future__ import annotations

from datetime import UTC, datetime

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from captureshark.adapters.orm import OAuthTokenRow
from captureshark.domain.auth import OAuthTokens, TokenStorePort


class SqliteTokenStore(TokenStorePort):
    """Encrypted-at-rest token store for one user's Google credentials."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        fernet: Fernet,
    ) -> None:
        self._session_factory = session_factory
        self._fernet = fernet

    async def save_for_user(self, user_id: int, tokens: OAuthTokens) -> None:
        access_ct = self._encrypt(tokens.access_token)
        refresh_ct = self._encrypt(tokens.refresh_token)
        scopes_str = _serialise_scopes(tokens.granted_scopes)

        async with self._session_factory.begin() as session:
            row = await session.scalar(
                select(OAuthTokenRow).where(OAuthTokenRow.user_id == user_id)
            )
            if row is None:
                row = OAuthTokenRow(
                    user_id=user_id,
                    access_token_ciphertext=access_ct,
                    refresh_token_ciphertext=refresh_ct,
                    access_token_expires_at=tokens.access_token_expires_at,
                    granted_scopes=scopes_str,
                )
                session.add(row)
            else:
                row.access_token_ciphertext = access_ct
                row.refresh_token_ciphertext = refresh_ct
                row.access_token_expires_at = tokens.access_token_expires_at
                row.granted_scopes = scopes_str
                row.updated_at = datetime.now(UTC)

    async def get_for_user(self, user_id: int) -> OAuthTokens | None:
        async with self._session_factory() as session:
            row = await session.scalar(
                select(OAuthTokenRow).where(OAuthTokenRow.user_id == user_id)
            )
            if row is None:
                return None
            try:
                access_token = self._decrypt(row.access_token_ciphertext)
                refresh_token = self._decrypt(row.refresh_token_ciphertext)
            except InvalidToken as exc:
                # Re-raised as a programmer error rather than swallowed:
                # ciphertext that won't decrypt means either the key
                # rotated without re-encrypting, or the row was tampered
                # with. Either way it's a deployment-level problem the
                # operator must see, not a "user is signed out" signal.
                raise RuntimeError(
                    "Stored OAuth ciphertext failed Fernet authentication. "
                    "Rotate TOKEN_ENCRYPTION_KEY only with a re-encryption "
                    "migration; raw key swaps will brick existing rows."
                ) from exc
            return OAuthTokens(
                access_token=access_token,
                refresh_token=refresh_token,
                access_token_expires_at=row.access_token_expires_at,
                granted_scopes=_parse_scopes(row.granted_scopes),
            )

    # ----- internals -------------------------------------------------------

    def _encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def _decrypt(self, ciphertext: str) -> str:
        return self._fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")


def _serialise_scopes(scopes: frozenset[str]) -> str:
    """Stable ordering so two equal scope sets serialise identically."""
    return " ".join(sorted(scopes))


def _parse_scopes(raw: str) -> frozenset[str]:
    return frozenset(s for s in raw.split(" ") if s)
