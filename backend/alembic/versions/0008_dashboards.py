"""dashboards and dashboard_charts tables

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dashboards",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("layout", sa.JSON(), nullable=False),
        sa.Column("refresh_interval", sa.String(10), nullable=False, server_default="off"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "dashboard_charts",
        sa.Column(
            "dashboard_id",
            sa.Integer(),
            sa.ForeignKey("dashboards.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "chart_id",
            sa.Integer(),
            sa.ForeignKey("charts.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
    )
    op.create_index("ix_dashboard_charts_chart_id", "dashboard_charts", ["chart_id"])


def downgrade() -> None:
    op.drop_table("dashboard_charts")
    op.drop_table("dashboards")
