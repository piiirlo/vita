"""Build SQL on top of a dataset with sqlglot (never by joining strings).

Identifiers we add (schema, table, column names, aliases) are always quoted, so names
with spaces, capitals or reserved words work: "Order Items" on Postgres, `Order Items`
on MySQL. The user's own SQL (kind="sql") is parsed and re-rendered without forcing
quotes, so `FROM Orders` keeps its meaning (on Postgres unquoted names are lowercased).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, TokenError

from app.query.errors import QueryError
from app.query.validate import DIALECTS

# Same alias Superset uses for SQL datasets.
VIRTUAL_TABLE_ALIAS = "virtual_table"


@dataclass(frozen=True)
class DatasetSource:
    """Where a dataset's rows come from."""

    kind: Literal["table", "sql"]
    schema: str | None = None
    table_name: str | None = None
    sql: str | None = None


class _HasSource(Protocol):
    kind: str
    schema: str | None
    table_name: str | None
    sql: str | None


def source_of(dataset: _HasSource) -> DatasetSource:
    """The source of a Dataset model (or anything with the same fields)."""
    if dataset.kind == "table":
        return DatasetSource("table", schema=dataset.schema, table_name=dataset.table_name)
    return DatasetSource("sql", sql=dataset.sql)


def dialect_for(db_type: str) -> str:
    try:
        return DIALECTS[db_type]
    except KeyError:
        raise QueryError("invalid", f"Unsupported database type: {db_type}") from None


def quoted(name: str) -> exp.Identifier:
    return exp.to_identifier(name, quoted=True)


def column(name: str) -> exp.Column:
    """A quoted column reference, e.g. "order_date"."""
    return exp.Column(this=quoted(name))


def table_ref(schema: str | None, table: str) -> exp.Table:
    """A quoted table reference: "schema"."table" (on MySQL the schema is the database)."""
    return exp.Table(this=quoted(table), db=quoted(schema) if schema else None)


def parse_dataset_query(sql: str, db_type: str) -> exp.Query:
    """Parse the SQL of a SQL dataset into one query expression (trailing ';' is fine).
    checks.check_dataset_sql gives the readable safety errors; this is the last guard."""
    try:
        statements = [
            s
            for s in sqlglot.parse(sql, dialect=dialect_for(db_type))
            if s is not None and not isinstance(s, exp.Semicolon)
        ]
    except (ParseError, TokenError):
        raise QueryError("syntax", "The dataset's SQL has a syntax error.") from None
    if len(statements) != 1 or not isinstance(statements[0], exp.Query):
        raise QueryError("invalid", "A SQL dataset must be a single SELECT query.")
    return statements[0]


def from_clause(source: DatasetSource, db_type: str) -> exp.Expr:
    """What goes after FROM: a quoted table, or the dataset's query as an aliased subquery."""
    if source.kind == "table":
        if not source.table_name:
            raise QueryError("invalid", "The dataset has no table.")
        return table_ref(source.schema, source.table_name)
    if not source.sql:
        raise QueryError("invalid", "The dataset has no SQL.")
    query = parse_dataset_query(source.sql, db_type)
    return exp.Subquery(this=query, alias=exp.TableAlias(this=quoted(VIRTUAL_TABLE_ALIAS)))


def select_sql(
    source: DatasetSource,
    db_type: str,
    projections: Sequence[exp.Expr] | None = None,
    limit: int | None = None,
) -> str:
    """SELECT <projections or *> FROM <dataset> [LIMIT n], rendered for the dialect."""
    select = exp.select(*(projections or [exp.Star()])).from_(from_clause(source, db_type))
    if limit is not None:
        select = select.limit(limit)
    return select.sql(dialect=dialect_for(db_type))


def sqllab_sql(source: DatasetSource, db_type: str) -> str:
    """SQL to open in SQL Lab: the dataset's own query, or SELECT * FROM the table."""
    if source.kind == "sql":
        return source.sql or ""
    return select_sql(source, db_type)
