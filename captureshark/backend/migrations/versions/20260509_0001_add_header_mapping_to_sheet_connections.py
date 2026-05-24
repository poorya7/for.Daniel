"""add header_mapping_json to sheet_connections (step 5c)

Revision ID: a3c1f5e2b8d4
Revises: 7ab0f7a76dd5
Create Date: 2026-05-09 00:01:00.000000

Stores the user-confirmed column mapping (lead-field → sheet-header)
as a JSON blob alongside the connection. `None` until the user
confirms the mapping screen — saves fall back to the fixed-order
writer in that state. Once set, every save reads live headers and
projects through this mapping.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


# Revision identifiers, used by Alembic.
revision: str = "a3c1f5e2b8d4"
down_revision: str | None = "7ab0f7a76dd5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("sheet_connections", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("header_mapping_json", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    with op.batch_alter_table("sheet_connections", schema=None) as batch_op:
        batch_op.drop_column("header_mapping_json")
