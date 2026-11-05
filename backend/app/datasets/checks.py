"""Safety checks for SQL datasets and metric expressions (no database needed)."""

import re

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, TokenError

from app.datasets.sql import dialect_for, parse_dataset_query
from app.query.errors import QueryError
from app.query.validate import check_read_only, prepare_sql

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def check_dataset_sql(sql: str, db_type: str) -> list[str]:
    """Raise QueryError unless `sql` is one read-only SELECT query (the same checks as
    SQL Lab). Returns warnings for things that are allowed but often surprising."""
    prepare_sql(sql, db_type, fetch_limit=1)  # one statement, read-only, readable errors
    try:
        statement = parse_dataset_query(sql, db_type)
    except QueryError:
        raise QueryError(
            "not_allowed",
            "A SQL dataset must be a SELECT query (WITH and UNION are fine; "
            "SHOW, DESCRIBE and EXPLAIN are not).",
        ) from None
    return query_warnings(statement)


def query_warnings(statement: exp.Query) -> list[str]:
    warnings: list[str] = []
    if statement.args.get("order"):
        warnings.append(
            "The query ends with ORDER BY. Charts add their own grouping and sorting on top, "
            "so this order is usually lost and only makes the query slower."
        )
    if statement.args.get("limit") or statement.args.get("fetch"):
        warnings.append(
            "The query ends with LIMIT. Charts will only ever see these rows, "
            "so totals and counts can be surprisingly low."
        )
    return warnings


def parse_metric_expression(expression: str, db_type: str) -> exp.Expression:
    """Parse a metric expression like SUM(amount) or COUNT(DISTINCT customer_id).

    It must be exactly one SQL expression: no second statement, no FROM/WHERE/alias,
    and nothing that writes. Returns the parsed expression to build SQL with.
    """
    text = expression.strip()
    if not text:
        raise QueryError("invalid", "The expression is empty.")
    dialect = dialect_for(db_type)
    try:
        statements = [
            s
            for s in sqlglot.parse(f"SELECT {text}", dialect=dialect)
            if s is not None and not isinstance(s, exp.Semicolon)
        ]
    except (ParseError, TokenError) as e:
        raise QueryError("syntax", f"The expression has a syntax error{_near(e)}.") from None

    if len(statements) != 1:
        raise QueryError(
            "multiple_statements",
            "The expression must be a single SQL expression, not several statements.",
        )
    select = statements[0]
    if not isinstance(select, exp.Select):
        raise QueryError("invalid", "The expression must be a single SQL expression.")
    extra = [key for key, value in select.args.items() if value and key != "expressions"]
    if extra or len(select.expressions) != 1:
        raise QueryError(
            "invalid",
            "The expression must be a single SQL expression like SUM(amount), "
            "without FROM, WHERE, commas or other clauses.",
        )
    projection = select.expressions[0]
    if isinstance(projection, exp.Alias):
        raise QueryError(
            "invalid", "Leave out the alias (AS ...); the metric name is used as the column name."
        )
    if isinstance(projection, exp.Star):
        raise QueryError("invalid", "* is not a metric. Did you mean COUNT(*)?")
    check_read_only(select, dialect)  # writes hidden in subqueries, SELECT ... INTO
    return projection


def metric_warning(expression: exp.Expression) -> str | None:
    """A hint when a metric isn't an aggregate (allowed, but rarely what you want)."""
    if expression.find(exp.AggFunc) is None:
        return (
            "This expression has no aggregate function (SUM, COUNT, AVG, ...). "
            "Metrics are usually aggregates; otherwise charts can't group by other columns."
        )
    return None


def _near(error: ParseError | TokenError) -> str:
    if isinstance(error, ParseError) and error.errors:
        near = _ANSI.sub("", str(error.errors[0].get("highlight") or "")).strip()
        if near:
            return f" near '{near}'"
    return ""
