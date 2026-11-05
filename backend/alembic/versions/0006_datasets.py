"""datasets, dataset_columns, dataset_metrics

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "datasets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "connection_id",
            sa.Integer(),
            sa.ForeignKey("connections.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("schema", sa.String(255), nullable=True),
        sa.Column("table_name", sa.String(255), nullable=True),
        sa.Column("sql", sa.Text(), nullable=True),
        sa.Column("main_time_column", sa.String(255), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "(kind = 'table' AND schema IS NOT NULL AND table_name IS NOT NULL AND sql IS NULL)"
            " OR (kind = 'sql' AND sql IS NOT NULL AND schema IS NULL AND table_name IS NULL)",
            name="ck_datasets_kind_fields",
        ),
    )
    op.create_index("ix_datasets_connection_id", "datasets", ["connection_id"])

    op.create_table(
        "dataset_columns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(255), nullable=True),
        sa.Column("raw_type", sa.String(255), nullable=False),
        sa.Column("generic_type", sa.String(20), nullable=False),
        sa.Column("generic_type_override", sa.String(20), nullable=True),
        sa.Column("is_temporal", sa.Boolean(), nullable=False),
        sa.Column("is_dimension", sa.Boolean(), nullable=False),
        sa.Column("is_hidden", sa.Boolean(), nullable=False),
        sa.Column("is_missing", sa.Boolean(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.UniqueConstraint("dataset_id", "name"),
    )
    op.create_index("ix_dataset_columns_dataset_id", "dataset_columns", ["dataset_id"])

    op.create_table(
        "dataset_metrics",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("label", sa.String(255), nullable=True),
        sa.Column("expression", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("number_format", sa.String(50), nullable=True),
        sa.Column("is_builtin", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("dataset_id", "name"),
    )
    op.create_index("ix_dataset_metrics_dataset_id", "dataset_metrics", ["dataset_id"])


def downgrade() -> None:
    op.drop_table("dataset_metrics")
    op.drop_table("dataset_columns")
    op.drop_table("datasets")
