"""Tables, columns and foreign keys of one schema, for the Browse page's diagram view.

One inspector pass for the whole schema (get_multi_*), not one query per table, so it stays
quick with 100+ tables. Falls back to information_schema on Postgres servers that deny
access to system catalogs (like app/browsing.py does for columns).
"""

from typing import Literal

import psycopg.errors
from sqlalchemy import Connection, inspect, text
from sqlalchemy.engine.reflection import ObjectKind
from sqlalchemy.exc import DBAPIError

from app.browsing import PG_TYPE_NAMES
from app.schemas.connections import DiagramColumn, DiagramForeignKey, DiagramTable, SchemaDiagram

MAX_DIAGRAM_TABLES = 1000

Kind = Literal["table", "view"]
# table -> (kind, [(column, type, nullable)])
TableColumns = dict[str, tuple[Kind, list[tuple[str, str, bool]]]]


def read_schema_diagram(conn: Connection, db_type: str, schema: str) -> SchemaDiagram:
    try:
        tables, primary, foreign = _via_inspector(conn, schema)
    except DBAPIError as exc:
        if db_type == "postgresql" and isinstance(exc.orig, psycopg.errors.InsufficientPrivilege):
            conn.rollback()  # the failed query aborted the transaction
            tables, primary, foreign = _pg_via_information_schema(conn, schema)
        else:
            raise
    return build_diagram(schema, tables, primary, foreign)


def _via_inspector(
    conn: Connection, schema: str
) -> tuple[TableColumns, dict[str, set[str]], list[DiagramForeignKey]]:
    insp = inspect(conn)
    views = set(insp.get_view_names(schema=schema))
    columns = insp.get_multi_columns(schema=schema, kind=ObjectKind.ANY)
    pks = insp.get_multi_pk_constraint(schema=schema, kind=ObjectKind.TABLE)
    fks = insp.get_multi_foreign_keys(schema=schema, kind=ObjectKind.TABLE)

    tables: TableColumns = {}
    for (_, table), cols in columns.items():
        typed: list[tuple[str, str, bool]] = []
        for col in cols:
            try:
                type_name = col["type"].compile(dialect=conn.dialect)
            except Exception:  # exotic types that can't be compiled
                type_name = type(col["type"]).__name__
            typed.append((col["name"], type_name, bool(col["nullable"])))
        tables[table] = ("view" if table in views else "table", typed)
    primary = {table: set(pk.get("constrained_columns") or []) for (_, table), pk in pks.items()}
    foreign = [
        DiagramForeignKey(
            name=fk.get("name"),
            table=table,
            columns=list(fk["constrained_columns"]),
            referred_schema=fk.get("referred_schema") or schema,
            referred_table=fk["referred_table"],
            referred_columns=list(fk["referred_columns"]),
        )
        for (_, table), table_fks in fks.items()
        for fk in table_fks
    ]
    return tables, primary, foreign


def _pg_via_information_schema(
    conn: Connection, schema: str
) -> tuple[TableColumns, dict[str, set[str]], list[DiagramForeignKey]]:
    params = {"schema": schema}
    tables: TableColumns = {}
    for name, table_type in conn.execute(
        text(
            "SELECT table_name, table_type FROM information_schema.tables "
            "WHERE table_schema = :schema"
        ),
        params,
    ):
        tables[str(name)] = ("view" if table_type == "VIEW" else "table", [])
    for table, column, data_type, nullable in conn.execute(
        text(
            "SELECT table_name, column_name, data_type, is_nullable "
            "FROM information_schema.columns WHERE table_schema = :schema "
            "ORDER BY table_name, ordinal_position"
        ),
        params,
    ):
        type_name = PG_TYPE_NAMES.get(str(data_type), str(data_type).upper())
        entry = tables.setdefault(str(table), ("table", []))
        entry[1].append((str(column), type_name, nullable == "YES"))

    primary: dict[str, set[str]] = {}
    for table, column in conn.execute(
        text(
            "SELECT kcu.table_name, kcu.column_name "
            "FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON kcu.constraint_schema = tc.constraint_schema "
            " AND kcu.constraint_name = tc.constraint_name "
            "WHERE tc.table_schema = :schema AND tc.constraint_type = 'PRIMARY KEY'"
        ),
        params,
    ):
        primary.setdefault(str(table), set()).add(str(column))

    grouped: dict[tuple[str, str], DiagramForeignKey] = {}
    for name, table, column, ref_schema, ref_table, ref_column in conn.execute(
        text(
            "SELECT kcu.constraint_name, kcu.table_name, kcu.column_name, "
            "       rk.table_schema, rk.table_name, rk.column_name "
            "FROM information_schema.referential_constraints rc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON kcu.constraint_schema = rc.constraint_schema "
            " AND kcu.constraint_name = rc.constraint_name "
            "JOIN information_schema.key_column_usage rk "
            "  ON rk.constraint_schema = rc.unique_constraint_schema "
            " AND rk.constraint_name = rc.unique_constraint_name "
            " AND rk.ordinal_position = kcu.position_in_unique_constraint "
            "WHERE kcu.table_schema = :schema "
            "ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position"
        ),
        params,
    ):
        fk = grouped.setdefault(
            (str(table), str(name)),
            DiagramForeignKey(
                name=str(name),
                table=str(table),
                columns=[],
                referred_schema=str(ref_schema),
                referred_table=str(ref_table),
                referred_columns=[],
            ),
        )
        fk.columns.append(str(column))
        fk.referred_columns.append(str(ref_column))
    return tables, primary, list(grouped.values())


def build_diagram(
    schema: str,
    tables: TableColumns,
    primary: dict[str, set[str]],
    foreign: list[DiagramForeignKey],
    limit: int = MAX_DIAGRAM_TABLES,
) -> SchemaDiagram:
    """Sorted tables with PK / FK markers; at most `limit` tables (and their foreign keys)."""
    names = sorted(tables)
    kept = names[:limit]
    fk_columns: dict[str, set[str]] = {}
    for fk in foreign:
        fk_columns.setdefault(fk.table, set()).update(fk.columns)
    return SchemaDiagram(
        schema_name=schema,
        tables=[
            DiagramTable(
                name=name,
                type=tables[name][0],
                columns=[
                    DiagramColumn(
                        name=col,
                        type=type_name,
                        nullable=nullable,
                        primary_key=col in primary.get(name, set()),
                        foreign_key=col in fk_columns.get(name, set()),
                    )
                    for col, type_name, nullable in tables[name][1]
                ],
            )
            for name in kept
        ],
        foreign_keys=[fk for fk in foreign if fk.table in set(kept)],
        truncated=len(names) > limit,
    )
