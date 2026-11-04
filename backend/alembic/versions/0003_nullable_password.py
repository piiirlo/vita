"""connections.password_encrypted nullable (NULL = no password)

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("connections", "password_encrypted", existing_type=sa.Text(), nullable=True)

    # Rows saved before this migration stored "no password" as an encrypted empty
    # string. Normalize those to NULL.
    from cryptography.fernet import InvalidToken

    from app.crypto import decrypt_password

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, password_encrypted FROM connections")).all()
    for row_id, token in rows:
        try:
            is_empty = decrypt_password(token) == ""
        except InvalidToken:
            continue  # encrypted with another key; leave it alone
        if is_empty:
            conn.execute(
                sa.text("UPDATE connections SET password_encrypted = NULL WHERE id = :id"),
                {"id": row_id},
            )


def downgrade() -> None:
    from app.crypto import encrypt_password

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id FROM connections WHERE password_encrypted IS NULL")
    ).all()
    for (row_id,) in rows:
        conn.execute(
            sa.text("UPDATE connections SET password_encrypted = :token WHERE id = :id"),
            {"token": encrypt_password(""), "id": row_id},
        )
    op.alter_column("connections", "password_encrypted", existing_type=sa.Text(), nullable=False)
