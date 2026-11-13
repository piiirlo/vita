"""Part 13: year-number / text-date time columns, identifier columns, dataset notes

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-12

Number and text columns that were marked temporal before Part 13 become time_kind
"pending": the backend checks their values lazily (dataset page, Sync columns, chart data),
never here and never at startup (user databases may be slow, offline or confidential).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Same rule as app/datasets/timecols.py IDENTIFIER_TOKENS (copied: migrations don't import
# app code). Matched on the lower-cased name split on anything that isn't a letter or digit.
_IDENTIFIER_RE = (
    r"(^|[^a-z0-9])(id|uuid|guid|key|code|zip|zipcode|postal|postcode|phone|tel|telephone"
    r"|fax|sku|ean|upc|isbn|gtin|iban|ssn|rank)([^a-z0-9]|$)"
)


def upgrade() -> None:
    op.add_column("datasets", sa.Column("notes", sa.JSON(), nullable=True))
    op.add_column("dataset_columns", sa.Column("time_kind", sa.String(20), nullable=True))
    op.add_column("dataset_columns", sa.Column("text_date_format", sa.String(3), nullable=True))
    op.add_column(
        "dataset_columns",
        sa.Column("is_identifier", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "dataset_columns",
        sa.Column("looks_like_years", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        "UPDATE dataset_columns SET time_kind = 'pending' WHERE is_temporal "
        "AND COALESCE(generic_type_override, generic_type) NOT IN ('date', 'datetime')"
    )
    # "RowID", "Postal Code", "customer_id": split camelCase first, then match the tokens.
    op.execute(
        "UPDATE dataset_columns SET is_identifier = true "
        "WHERE COALESCE(generic_type_override, generic_type) = 'number' AND "
        "lower(regexp_replace(name, '([a-z0-9])([A-Z])', '\\1_\\2', 'g')) "
        f"~ '{_IDENTIFIER_RE}'"
    )


def downgrade() -> None:
    op.drop_column("dataset_columns", "looks_like_years")
    op.drop_column("dataset_columns", "is_identifier")
    op.drop_column("dataset_columns", "text_date_format")
    op.drop_column("dataset_columns", "time_kind")
    op.drop_column("datasets", "notes")
