"""ORM model for the idempotency-key cache.

Kept in its own module so `orm.py` stays focused on the auth / session
/ token surface (which is what its docstring scopes it to). Both files
hang off the same shared `Base.metadata`, so Alembic / `create_all`
sees them as one schema — splitting by concern is purely about
readability and review-blast-radius, not table grouping.

See `domain/idempotency.py` for the port this row supports, and
`adapters/sqlite_idempotency_store.py` for the adapter that reads /
writes these rows.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from captureshark.db.base import Base
from captureshark.db.types import UtcDateTime


def _utc_now() -> datetime:
    """Timezone-aware UTC default-factory. Mirrors the helper in `orm.py`
    — duplicated rather than imported so this module has no cross-ORM
    dependency edge."""
    return datetime.now(UTC)


class IdempotencyKeyRow(Base):
    """Cached responses for client-supplied idempotency keys.

    The offline-resilient capture queue (plan §7) retries the same
    logical save with the same `key` after ambiguous failures.
    Looking up the key here lets the save route replay the original
    response instead of re-running the Sheets write — preventing the
    "row written, network dropped, client retried, row written twice"
    duplicate that would otherwise pollute the user's sheet silently.

    Scoping by `user_id` is defence-in-depth: with uuid v4 keys the
    collision probability is astronomical, but cross-user replay
    would still be a confidentiality bug worth blocking at the
    storage layer.

    Persistence (not in-memory) is non-negotiable per both reviewer
    passes — server restarts cannot lose the key set or every deploy
    becomes a duplicate-row event.
    """

    __tablename__ = "idempotency_keys"

    # The uuid v4 the client generated at submit time. Globally unique
    # in expectation, but we still scope lookups by `user_id`.
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    # Cached HTTP status. v1 only writes 200 here; the column accepts
    # any int so we have room to start caching permanent-failure
    # codes (404, 403) later without a schema change.
    cached_status: Mapped[int] = mapped_column()
    # Cached response body, serialised JSON. `Text` because some
    # save responses carry verbose row-target metadata; bounded
    # `String(N)` would invite truncation bugs at unknown N.
    cached_body_json: Mapped[str] = mapped_column(Text)
    # Indexed so the periodic sweep (`sweep_expired`) can find expired
    # rows efficiently without a full table scan. Declared before
    # `created_at` so the dataclass init signature keeps the required
    # field ahead of the defaulted one (Python dataclass rule).
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime, index=True)
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime,
        default_factory=_utc_now,
    )
