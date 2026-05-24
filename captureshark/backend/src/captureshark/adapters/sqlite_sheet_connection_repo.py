"""SQLAlchemy-backed implementation of `SheetConnectionRepoPort`.

Mirror of `sqlite_user_repo.py` and friends — own the async sessionmaker,
open a fresh session per public method, convert at the boundary
(`SheetConnectionRow` ORM → `SheetConnection` domain). The domain value
is frozen so it can't accidentally mutate a row still attached to a
session.

The `header_mapping` field (step 5c) is stored as a JSON blob in
`sheet_connections.header_mapping_json`. We serialise/deserialise at
this boundary so every other layer sees the typed
`ColumnMapping` value object — only the SQL adapter knows about JSON.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from captureshark.adapters.orm import SheetConnectionRow
from captureshark.domain.column_mapping import ColumnMapping, LeadField
from captureshark.domain.sheets import SheetConnection, SheetConnectionRepoPort


class SqliteSheetConnectionRepo(SheetConnectionRepoPort):
    """Async SQLite implementation of the per-user sheet-connection store."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def get_for_user(self, user_id: int) -> SheetConnection | None:
        async with self._session_factory() as session:
            row = await session.scalar(
                select(SheetConnectionRow).where(SheetConnectionRow.user_id == user_id)
            )
            return _row_to_domain(row) if row is not None else None

    async def upsert_for_user(
        self,
        *,
        user_id: int,
        spreadsheet_id: str,
        display_name: str,
        worksheet_title: str = "Sheet1",
    ) -> SheetConnection:
        async with self._session_factory.begin() as session:
            row = await session.scalar(
                select(SheetConnectionRow).where(SheetConnectionRow.user_id == user_id)
            )
            if row is None:
                row = SheetConnectionRow(
                    user_id=user_id,
                    spreadsheet_id=spreadsheet_id,
                    display_name=display_name,
                    worksheet_title=worksheet_title,
                )
                session.add(row)
                await session.flush()
            else:
                row.spreadsheet_id = spreadsheet_id
                row.display_name = display_name
                row.worksheet_title = worksheet_title
                # Picking a (possibly different) sheet invalidates the
                # previous mapping — the new sheet's headers may not
                # match. Mapping screen runs again on next save.
                row.header_mapping_json = None
                row.updated_at = datetime.now(UTC)
                await session.flush()
            return _row_to_domain(row)

    async def update_mapping_for_user(
        self,
        *,
        user_id: int,
        mapping: ColumnMapping,
    ) -> SheetConnection:
        async with self._session_factory.begin() as session:
            row = await session.scalar(
                select(SheetConnectionRow).where(SheetConnectionRow.user_id == user_id)
            )
            if row is None:
                # Caller is expected to have ensured connect ran first.
                # This is a 4xx-shaped error in API terms; the route
                # layer translates `LookupError` to a 409.
                raise LookupError(f"No sheet connection for user {user_id}")
            row.header_mapping_json = _mapping_to_json(mapping)
            row.updated_at = datetime.now(UTC)
            await session.flush()
            return _row_to_domain(row)

    async def delete_for_user(self, user_id: int) -> None:
        async with self._session_factory.begin() as session:
            row = await session.scalar(
                select(SheetConnectionRow).where(SheetConnectionRow.user_id == user_id)
            )
            if row is not None:
                await session.delete(row)


def _row_to_domain(row: SheetConnectionRow) -> SheetConnection:
    return SheetConnection(
        user_id=row.user_id,
        spreadsheet_id=row.spreadsheet_id,
        display_name=row.display_name,
        worksheet_title=row.worksheet_title,
        header_mapping=_json_to_mapping(row.header_mapping_json),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _mapping_to_json(mapping: ColumnMapping) -> str:
    """Serialise `ColumnMapping` for SQLite storage.

    Wire format on disk:
        {"fields": {"name": "Lead Name", "phone": "Tel", ...},
         "unmapped_headers": ["Source", "Lead Score"]}

    Keys are `LeadField.value` strings (already what the API uses on
    the wire) so the JSON we store matches the JSON we expose. Round-
    trips through `_json_to_mapping` losslessly.
    """
    payload: dict[str, Any] = {
        "fields": {field.value: header for field, header in mapping.fields.items()},
        "unmapped_headers": list(mapping.unmapped_headers),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _json_to_mapping(raw: str | None) -> ColumnMapping | None:
    """Parse the stored JSON back into a `ColumnMapping`.

    Tolerant: `None`, an empty string, or malformed JSON all return
    `None` rather than raising — a corrupted row is handled the same
    as a never-confirmed one (saves fall back to fixed-order cells)
    instead of breaking the user's save flow. Logged via the warning
    path on the next surrounding call site if we want to surface it.
    """
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    raw_fields = data.get("fields")
    if not isinstance(raw_fields, dict):
        return None

    fields: dict[LeadField, str | None] = {}
    for field in LeadField:
        value = raw_fields.get(field.value)
        if value is None or isinstance(value, str):
            fields[field] = value
        else:
            fields[field] = None
    raw_unmapped = data.get("unmapped_headers", [])
    unmapped = (
        tuple(h for h in raw_unmapped if isinstance(h, str))
        if isinstance(raw_unmapped, list)
        else ()
    )
    return ColumnMapping(fields=fields, unmapped_headers=unmapped)
