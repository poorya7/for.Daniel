"""SQLAlchemy ORM models for the auth / session / token store.

These rows are an *adapter-layer* concern — they shape what's on disk,
not what the domain reasons about. `domain/auth.py` defines the pure
`User`, `OAuthTokens`, `Session` value objects; the adapters translate
between rows here and those domain types at the storage boundary.

Layout (all FKs use `ON DELETE CASCADE` so deleting a user wipes their
tokens and sessions atomically — no orphan rows):

    users                       — one row per Google identity that has
                                  ever signed in
    oauth_tokens (1:1 user)     — the encrypted refresh + access tokens
                                  needed to call Google APIs as that user
    sessions     (N:1 user)     — opaque session identifiers a browser
                                  presents via the HttpOnly cookie

Encryption note: `access_token_ciphertext` and `refresh_token_ciphertext`
hold Fernet ciphertext (urlsafe-base64 strings, plain `Mapped[str]`).
The plaintext never touches the DB; encryption/decryption is the
adapter's job, with the key sourced from `Settings.token_encryption_key`.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from captureshark.db.base import Base
from captureshark.db.types import UtcDateTime


def _utc_now() -> datetime:
    """Return a timezone-aware UTC `datetime`. Default-factory for rows."""
    return datetime.now(UTC)


class UserRow(Base):
    """One row per Google identity that has ever completed sign-in.

    `google_user_id` is the OAuth `sub` claim — Google's stable, opaque
    user identifier. Email is captured for display + admin lookup, but
    `sub` is the source of truth (a user can change their primary email
    without becoming a new account).
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, init=False)
    google_user_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    name: Mapped[str | None] = mapped_column(String(256), default=None)
    picture_url: Mapped[str | None] = mapped_column(String(2048), default=None)
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )

    tokens: Mapped[OAuthTokenRow | None] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        uselist=False,
        init=False,
    )
    sessions: Mapped[list[SessionRow]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        init=False,
    )


class OAuthTokenRow(Base):
    """The encrypted Google access + refresh tokens for a user.

    1:1 with `users` — when a user re-authorises, the existing row is
    updated in place, not duplicated. `access_token_expires_at` is read
    by the auth service to decide whether to refresh transparently
    before calling a Google API.
    """

    __tablename__ = "oauth_tokens"

    id: Mapped[int] = mapped_column(primary_key=True, init=False)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    access_token_ciphertext: Mapped[str] = mapped_column(String(4096))
    refresh_token_ciphertext: Mapped[str] = mapped_column(String(4096))
    access_token_expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    granted_scopes: Mapped[str] = mapped_column(String(2048))
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )

    user: Mapped[UserRow] = relationship(back_populates="tokens", init=False)


class SheetConnectionRow(Base):
    """The Google Sheet a user picked for CaptureShark to write into.

    1:1 with `users` for v1 (one connected sheet per user) — the spec
    explicitly defers multi-sheet support to v2. Re-running the Picker
    overwrites this row, which is what *Change sheet* does.

    `display_name` is captured at pick time so the post-save
    confirmation card (*"It's in Open House Leads now."*) can render
    without a fresh Sheets API round-trip on every save.
    """

    __tablename__ = "sheet_connections"

    id: Mapped[int] = mapped_column(primary_key=True, init=False)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    spreadsheet_id: Mapped[str] = mapped_column(String(128))
    display_name: Mapped[str] = mapped_column(String(512))
    # Worksheet (tab) we append to. Defaults to Sheets' "Sheet1" but
    # may be overridden by the user later (UI not in v1; the column
    # is here so we don't need a migration when it lands).
    worksheet_title: Mapped[str] = mapped_column(String(256), default="Sheet1")
    # JSON-serialised `ColumnMapping` (step 5c). `None` until the user
    # confirms the mapping screen — saves fall back to fixed-order
    # cells in that state. `Text` rather than `String(N)` because the
    # mapping JSON is unbounded in principle (long unmapped-headers
    # lists on a wide sheet).
    header_mapping_json: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )

    user: Mapped[UserRow] = relationship(init=False)


class SessionRow(Base):
    """A live browser session — what the HttpOnly cookie identifies.

    `id` is a high-entropy random opaque token (urlsafe base64); the
    cookie carries an itsdangerous-signed copy of it. We accept the
    cookie if (a) the signature verifies and (b) a row with that id
    still exists. Sign-out deletes the row, so revocation is instant.
    """

    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    user_agent: Mapped[str | None] = mapped_column(String(512), default=None)
    ip_address: Mapped[str | None] = mapped_column(String(64), default=None)
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
        index=True,
    )

    user: Mapped[UserRow] = relationship(back_populates="sessions", init=False)
