"""Read column metadata from a user database.

Normally uses the SQLAlchemy inspector. Some locked-down Postgres servers (for example
the public RNAcentral database) deny access to system catalogs the inspector needs, such
as pg_collation. In that case we fall back to information_schema, which every user can read.
"""

from collections.abc import Sequence
from typing import cast

import psycopg.errors
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import DBAPIError, NoSuchTableError

from app.schemas.connections import ColumnInfo

# information_schema.columns.data_type -> the names the SQLAlchemy inspector shows.
_PG_TYPE_NAMES = {
    "character varying": "VARCHAR",
    "character": "CHAR",
    "timestamp without time zone": "TIMESTAMP",
    "timestamp with time zone": "TIMESTAMP WITH TIME ZONE",
    "time without time zone": "TIME",
    "time with time zone": "TIME WITH TIME ZONE",
}


def read_columns(conn: Connection, db_type: str, schema: str, table: str) -> list[ColumnInfo]:
    """Columns of schema.table. Raises NoSuchTableError if the table doesn't exist."""
    try:
        return _columns_via_inspector(conn, schema, table)
    except DBAPIError as exc:
        if db_type == "postgresql" and isinstance(exc.orig, psycopg.errors.InsufficientPrivilege):
            conn.rollback()  # the failed query aborted the transaction
            return _pg_columns_via_information_schema(conn, schema, table)
        raise


def _columns_via_inspector(conn: Connection, schema: str, table: str) -> list[ColumnInfo]:
    insp = inspect(conn)
    columns = insp.get_columns(table, schema=schema)
    pk_columns = set(insp.get_pk_constraint(table, schema=schema)["constrained_columns"])

    result: list[ColumnInfo] = []
    for col in columns:
        try:
            type_name = col["type"].compile(dialect=conn.dialect)
        except Exception:  # some exotic types can't be compiled; fall back to the class name
            type_name = type(col["type"]).__name__
        result.append(
            ColumnInfo(
                name=col["name"],
                type=type_name,
                nullable=bool(col["nullable"]),
                primary_key=col["name"] in pk_columns,
            )
        )
    return result


def _pg_type_name(
    data_type: str, udt_name: str, char_len: int | None, precision: int | None, scale: int | None
) -> str:
    if data_type == "ARRAY":
        return f"{udt_name.lstrip('_').upper()}[]"
    if data_type == "USER-DEFINED":
        return udt_name
    name = _PG_TYPE_NAMES.get(data_type, data_type.upper())
    if char_len is not None:
        return f"{name}({char_len})"
    if data_type == "numeric" and precision is not None:
        return f"NUMERIC({precision}, {scale or 0})"
    return name


def _pg_columns_via_information_schema(
    conn: Connection, schema: str, table: str
) -> list[ColumnInfo]:
    # (name, data_type, udt_name, char_len, precision, scale, is_nullable)
    PgColumnRow = tuple[str, str, str, int | None, int | None, int | None, str]
    rows: Sequence[PgColumnRow] = cast(
        "Sequence[PgColumnRow]",
        conn.execute(
            text(
                """
            SELECT column_name, data_type, udt_name, character_maximum_length,
                   numeric_precision, numeric_scale, is_nullable
            FROM information_schema.columns
            WHERE table_schema = :schema AND table_name = :table
            ORDER BY ordinal_position
            """
            ),
            {"schema": schema, "table": table},
        ).all(),
    )
    if not rows:
        raise NoSuchTableError(f"{schema}.{table}")

    pk_columns: set[str] = set()
    try:
        pk_columns = set(
            conn.execute(
                text(
                    """
                    SELECT a.attname
                    FROM pg_index i
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                    WHERE i.indrelid =
                          (quote_ident(:schema) || '.' || quote_ident(:table))::regclass
                      AND i.indisprimary
                    """
                ),
                {"schema": schema, "table": table},
            ).scalars()
        )
    except DBAPIError:
        conn.rollback()  # primary keys unknown on this server; show columns anyway

    return [
        ColumnInfo(
            name=name,
            type=_pg_type_name(data_type, udt_name, char_len, precision, scale),
            nullable=is_nullable == "YES",
            primary_key=name in pk_columns,
        )
        for name, data_type, udt_name, char_len, precision, scale, is_nullable in rows
    ]
