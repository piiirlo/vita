"""Part 10: value labels on columns, chart-data cache, dashboard cache setting, 24-column grid

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-10

The dashboard grid goes from 12 to 24 columns with half-height rows (40px -> 14px; the 12px
margin stays). Doubling x, y, w and h keeps every tile at exactly the same pixel position and
size (see app/dashboard_grid.py), so existing dashboards look the same.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.dashboard_grid import scale_layout

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

dashboards = sa.table(
    "dashboards", sa.column("id", sa.Integer()), sa.column("layout", sa.JSON())
)


def _rescale(factor: float) -> None:
    conn = op.get_bind()
    for row in conn.execute(sa.select(dashboards.c.id, dashboards.c.layout)).all():
        conn.execute(
            dashboards.update()
            .where(dashboards.c.id == row.id)
            .values(layout=scale_layout(row.layout or [], factor))
        )


def upgrade() -> None:
    op.add_column("dataset_columns", sa.Column("value_labels", sa.JSON(), nullable=True))
    op.add_column("dashboards", sa.Column("cache_ttl", sa.Integer(), nullable=True))
    op.create_table(
        "chart_cache",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key", sa.String(64), nullable=False, unique=True),
        sa.Column(
            "connection_id",
            sa.Integer(),
            sa.ForeignKey("connections.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_chart_cache_connection_id", "chart_cache", ["connection_id"])
    op.create_index("ix_chart_cache_expires_at", "chart_cache", ["expires_at"])
    _rescale(2)


def downgrade() -> None:
    _rescale(0.5)
    op.drop_index("ix_chart_cache_expires_at", table_name="chart_cache")
    op.drop_index("ix_chart_cache_connection_id", table_name="chart_cache")
    op.drop_table("chart_cache")
    op.drop_column("dashboards", "cache_ttl")
    op.drop_column("dataset_columns", "value_labels")
