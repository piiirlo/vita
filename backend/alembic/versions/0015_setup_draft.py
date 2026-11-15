"""Part 14 round 2: a project's unfinished setup (the 4-step wizard), to resume later

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("setup_draft", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "setup_draft")
