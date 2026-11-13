"""Part 13 round 3: dashboard tiles are placed freely (no more automatic compaction)

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-13

Until now the grid pulled every tile up on screen, whatever positions were stored. From now
on tiles stay where they are, so every stored layout gets the positions it was shown with:
existing dashboards look exactly the same. (Not reversible: the compacted positions are
also what the old grid would show.)
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.dashboard_grid import compact_vertical

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    dashboards = sa.table("dashboards", sa.column("id", sa.Integer), sa.column("layout", sa.JSON))
    for dashboard_id, layout in conn.execute(sa.select(dashboards.c.id, dashboards.c.layout)).all():
        if not layout:
            continue
        compacted = compact_vertical(list(layout))
        if compacted != layout:
            conn.execute(
                dashboards.update().where(dashboards.c.id == dashboard_id).values(layout=compacted)
            )


def downgrade() -> None:
    pass  # the compacted positions are what the old grid showed anyway
