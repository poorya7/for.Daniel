"""Custom SQLAlchemy column types — paper over backend quirks.

Why this file exists:

  * SQLite (via aiosqlite) doesn't actually preserve timezone metadata
    on `DateTime(timezone=True)` columns. We store an aware UTC value;
    we read back a *naive* `datetime` whose digits happen to be the
    same UTC clock-time. Anywhere downstream code compares a stored
    timestamp against `datetime.now(UTC)` then explodes with
    `TypeError: can't compare offset-naive and offset-aware datetimes`.

  * The fix at the seam: a `TypeDecorator` that re-attaches the UTC
    `tzinfo` whenever a naive `datetime` comes back from the driver.
    Postgres/MySQL preserve timezone properly so this is a no-op for
    them. Storage layout doesn't change; only the read-side coerces.

ORM models use `Mapped[datetime]` with `mapped_column(UtcDateTime)`
instead of the bare `DateTime(timezone=True)`. One typing change at
the boundary, zero kludges in business logic.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime, Dialect
from sqlalchemy.types import TypeDecorator


class UtcDateTime(TypeDecorator[datetime]):
    """Always-UTC `datetime` column.

    On write: requires a tz-aware datetime (we control the writers, so
    this is a programmer-error guard rather than user-facing).
    On read: re-attaches `tzinfo=UTC` if the underlying driver dropped
    it (SQLite, principally).
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(
        self, value: Any, dialect: Dialect
    ) -> datetime | None:
        if value is None:
            return None
        if not isinstance(value, datetime):
            raise TypeError(
                f"UtcDateTime expects a datetime, got {type(value).__name__}"
            )
        if value.tzinfo is None:
            raise ValueError(
                "UtcDateTime received a naive datetime — writers must use "
                "datetime.now(UTC) (or equivalent). Storing naive would "
                "lose the tz contract this column promises."
            )
        return value.astimezone(UTC)

    def process_result_value(
        self, value: Any, dialect: Dialect
    ) -> datetime | None:
        # SQLAlchemy + aiosqlite hand us a `datetime` (naive on SQLite
        # despite `timezone=True`) or `None`. We don't see strings with
        # the standard configuration; if a driver ever does, the
        # default `DateTime` impl would have failed at the same seam.
        if value is None:
            return None
        if not isinstance(value, datetime):
            raise TypeError(
                f"UtcDateTime got non-datetime from driver: {type(value).__name__}"
            )
        # SQLite path: digits are UTC, tz tag is missing — re-attach.
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
