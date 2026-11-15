"""Part 14: projects. A project owns its connections, uploads, datasets, saved queries,
charts and dashboards.

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-15

Everything that exists moves into one project, "My workspace": nothing is deleted or
renamed. Names become unique per project instead of globally. The built-in Uploads
connection belongs to no project (every project can use it; its datasets and uploads
belong to projects).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WORKSPACE = "My workspace"
# Tables with a name unique per project (was: globally unique).
NAMED = ("connections", "datasets", "charts", "dashboards")
OWNED = ("connections", "uploads", "datasets", "saved_queries", "charts", "dashboards")


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    conn = op.get_bind()
    workspace_id = conn.scalar(
        sa.text("INSERT INTO projects (name) VALUES (:name) RETURNING id"), {"name": WORKSPACE}
    )
    for table in OWNED:
        op.add_column(table, sa.Column("project_id", sa.Integer(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_project", table, "projects", ["project_id"], ["id"], ondelete="RESTRICT"
        )
        op.create_index(f"ix_{table}_project_id", table, ["project_id"])
        where = " WHERE builtin IS NULL" if table == "connections" else ""
        conn.execute(sa.text(f"UPDATE {table} SET project_id = :p{where}"), {"p": workspace_id})
        if table != "connections":
            op.alter_column(table, "project_id", nullable=False)
    op.create_check_constraint(
        "ck_connections_project", "connections", "builtin IS NOT NULL OR project_id IS NOT NULL"
    )
    for table in NAMED:
        op.drop_constraint(f"{table}_name_key", table, type_="unique")
        op.create_unique_constraint(f"uq_{table}_project_name", table, ["project_id", "name"])


def downgrade() -> None:
    # Fails if two projects have items with the same name (names were global before).
    for table in NAMED:
        op.drop_constraint(f"uq_{table}_project_name", table, type_="unique")
        op.create_unique_constraint(f"{table}_name_key", table, ["name"])
    op.drop_constraint("ck_connections_project", "connections", type_="check")
    for table in OWNED:
        op.drop_index(f"ix_{table}_project_id", table)
        op.drop_constraint(f"fk_{table}_project", table, type_="foreignkey")
        op.drop_column(table, "project_id")
    op.drop_table("projects")
