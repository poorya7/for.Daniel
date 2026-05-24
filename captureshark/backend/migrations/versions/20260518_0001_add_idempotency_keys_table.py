"""add idempotency_keys table (offline-queue dedupe store)

Revision ID: c9d2f1e84b3a
Revises: a3c1f5e2b8d4
Create Date: 2026-05-18 00:50:00.000000

Backs the `IdempotencyStorePort` adapter — the offline-resilient
capture queue retries the same logical save with the same `key` after
ambiguous failures, and the save route replays the cached response
instead of re-running the Sheets write. Without this table the
`/sheets/append` route raises `OperationalError: no such table` for
every signed-in save and falls into the generic 500 catch.

Schema mirrors `adapters/idempotency_orm.IdempotencyKeyRow`:
  * `key` (PK, String(64)) — uuid v4 the client minted.
  * `user_id` (FK users.id ON DELETE CASCADE, indexed) — defence in
    depth: keys are uuid v4, but cross-user replay would still be a
    confidentiality bug.
  * `cached_status` / `cached_body_json` — the response to replay.
  * `expires_at` (indexed) — the periodic sweep filters by this.
  * `created_at` — record audit.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


# Revision identifiers, used by Alembic.
revision: str = "c9d2f1e84b3a"
down_revision: str | None = "a3c1f5e2b8d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "idempotency_keys",
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("cached_status", sa.Integer(), nullable=False),
        sa.Column("cached_body_json", sa.Text(), nullable=False),
        sa.Column(
            "expires_at", sa.DateTime(timezone=True), nullable=False
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False
        ),
    )
    op.create_index(
        "ix_idempotency_keys_user_id",
        "idempotency_keys",
        ["user_id"],
    )
    op.create_index(
        "ix_idempotency_keys_expires_at",
        "idempotency_keys",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_idempotency_keys_expires_at", table_name="idempotency_keys"
    )
    op.drop_index(
        "ix_idempotency_keys_user_id", table_name="idempotency_keys"
    )
    op.drop_table("idempotency_keys")
