"""Part 12: file uploads (the uploads record) and built-in connections

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-11

The Uploads database itself (on the same Postgres server) and its roles are created at
startup by app/uploads/bootstrap.py: CREATE DATABASE can't run inside a migration's
transaction, and the roles' passwords come from VITA_SECRET_KEY.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("connections", sa.Column("builtin", sa.String(20), nullable=True))
    op.create_unique_constraint("uq_connections_builtin", "connections", ["builtin"])
    op.create_table(
        "uploads",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token", sa.String(64), nullable=False, unique=True),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("file_size", sa.BigInteger(), nullable=False),
        sa.Column("file_kind", sa.String(10), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, index=True),
        sa.Column("mode", sa.String(10), nullable=False, server_default="create"),
        sa.Column("options", sa.JSON(), nullable=True),
        sa.Column("table_schema", sa.String(63), nullable=True),
        sa.Column("table_name", sa.String(63), nullable=True),
        sa.Column("columns", sa.JSON(), nullable=True),
        sa.Column("row_count", sa.BigInteger(), nullable=True),
        sa.Column("rows_done", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("bad_values", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("warnings", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("uploads")
    op.drop_constraint("uq_connections_builtin", "connections", type_="unique")
    op.drop_column("connections", "builtin")
