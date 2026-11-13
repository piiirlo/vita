"""QueryError and translation of driver errors into readable messages."""

import re
from dataclasses import dataclass
from typing import Literal

import psycopg
import pymysql

from app.db_errors import friendly_db_error
from app.engines import ConnectionDetails

QueryErrorKind = Literal[
    "invalid",  # empty query, bad arguments
    "syntax",
    "multiple_statements",
    "read_only",  # tries to change data
    "not_allowed",  # not a read query (SET, CALL, ...)
    "not_found",  # unknown table / column / function / schema
    "permission",
    "timeout",
    "connection",
    "other",
]


@dataclass
class QueryError(Exception):
    """A query that failed. `message` is the detailed text (kept as before); `title` and
    `hint` are the plain-language version for the UI (filled in from the kind and the
    database's text when not given; None for errors Vita doesn't recognize, which then show
    `message`); `raw` is the database's own error, shown under "Details"."""

    kind: QueryErrorKind
    message: str
    line: int | None = None
    column: int | None = None
    title: str | None = None
    hint: str | None = None
    raw: str | None = None

    def __post_init__(self) -> None:
        if self.title is None:
            explained = explain(self.kind, self.raw or self.message)
            if explained is not None:
                self.title, hint = explained
                self.hint = self.hint or hint

    def __str__(self) -> str:
        return self.message


MAX_RAW_LENGTH = 2000

_TIME_FUNCTION = re.compile(
    r"\b(date_trunc|date_part|extract|make_date|makedate|to_char|date_bin|age|"
    r"date_format|str_to_date|year|month|weekday|dayofmonth|quarter)\s*\(",
    re.IGNORECASE,
)
_TIME_TYPE_TROUBLE = (
    "invalid input syntax for type date",
    "invalid input syntax for type timestamp",
    "date/time field value out of range",
    "incorrect datetime value",
    "incorrect date value",
    "truncated incorrect date",
    "truncated incorrect datetime",
)
_HINT_TIME = (
    "A number or text column is probably being used as a date. In the dataset's Columns "
    "tab, mark a column of years as “year (number)”, a text column of dates with its date "
    "format, or pick a real date column as the time column."
)
_HINT_COLUMN = (
    "Check the spelling. Names with capitals, spaces or accents need quotes "
    '(“"Order Date"” on Postgres, “`Order Date`” on MySQL). If the table changed, '
    "use Sync columns on the dataset."
)


def explain(kind: str, text: str) -> tuple[str, str | None] | None:
    """(title, hint) in plain language for an error, or None when it isn't recognized."""
    low = text.lower()
    time_trouble = any(t in low for t in _TIME_TYPE_TROUBLE) or (
        ("does not exist" in low or "operator does not exist" in low)
        and (
            _TIME_FUNCTION.search(text) is not None
            or ("operator does not exist" in low and ("date" in low or "timestamp" in low))
        )
    )
    if time_trouble:
        return "A date function got a value that isn't a date", _HINT_TIME
    if "division by zero" in low or "division by 0" in low:
        return (
            "Division by zero",
            "Some rows divide by 0. Wrap the divisor in NULLIF(…, 0), e.g. "
            "SUM(amount) / NULLIF(SUM(quantity), 0).",
        )
    match kind:
        case "syntax":
            return (
                "The SQL has a syntax error",
                "Look near the marked spot: a missing comma, an unclosed quote or "
                "parenthesis, or a keyword used as a name are the usual causes.",
            )
        case "multiple_statements":
            return "Only one statement can run at a time", "Run the statements one by one."
        case "read_only" | "not_allowed":
            return (
                "Vita only reads data",
                "Only read queries (SELECT, WITH ... SELECT, SHOW, EXPLAIN) can run.",
            )
        case "permission":
            return (
                "Permission denied",
                "The database user of this connection isn't allowed to read this. Ask the "
                "database owner for SELECT rights, or use another user in the connection.",
            )
        case "timeout":
            return (
                "The query took too long",
                "Add filters, pick a shorter time range or a smaller row limit.",
            )
        case "connection":
            if any(w in low for w in ("lost", "closed", "terminat", "gone away", "reset")):
                return (
                    "The connection to the database was lost",
                    "The database may have restarted or the network dropped. Try again.",
                )
            return (
                "Couldn't reach the database",
                "Check that the database is running and reachable from Vita, and the "
                "connection's settings, then try again.",
            )
        case "not_found":
            if "column" in low:
                return "Unknown column", _HINT_COLUMN
            if "function" in low:
                return (
                    "Unknown function, or wrong argument types",
                    "Check the function's name for this database, and the types of its "
                    "arguments: a CAST may be needed.",
                )
            if "relation" in low or "table" in low:
                return (
                    "Unknown table",
                    "Check the spelling and the schema (schema.table). If the table was "
                    "renamed or deleted, update the dataset.",
                )
            return "Something named in the query doesn't exist", None
    return None


def _raw_text(err: BaseException) -> str:
    return str(err).strip()[:MAX_RAW_LENGTH]


def read_only_error(what: str) -> QueryError:
    return QueryError(
        "read_only",
        f"Vita is read-only: {what} statements are not allowed. Only read queries can run.",
    )


def line_and_column(sql: str, position: int) -> tuple[int, int]:
    """1-based character position -> (line, column), both 1-based."""
    before = sql[: max(position - 1, 0)]
    line = before.count("\n") + 1
    column = len(before) - (before.rfind("\n") + 1) + 1
    return line, column


def translate_db_error(
    exc: BaseException, details: ConnectionDetails, sql: str, timeout_seconds: float
) -> QueryError:
    orig = getattr(exc, "orig", None) or exc
    if isinstance(orig, psycopg.Error):
        error = _postgres_error(orig, details, sql, timeout_seconds)
    elif isinstance(orig, pymysql.err.MySQLError):
        error = _mysql_error(orig, details, timeout_seconds)
    elif isinstance(orig, (TypeError, FileNotFoundError, OSError)):
        error = QueryError("connection", friendly_db_error(orig, details))
    else:
        error = QueryError("other", friendly_db_error(orig, details))
    # The database's own words (for "Details"), and the explanation based on them.
    return QueryError(error.kind, error.message, error.line, error.column, raw=_raw_text(orig))


def _timeout(timeout_seconds: float) -> QueryError:
    unit = "second" if timeout_seconds == 1 else "seconds"
    return QueryError(
        "timeout",
        f"Query timed out after {timeout_seconds:g} {unit} and was stopped. "
        "Try adding filters or a smaller time range.",
    )


def _postgres_error(
    err: psycopg.Error, details: ConnectionDetails, sql: str, timeout_seconds: float
) -> QueryError:
    state = err.sqlstate or ""
    diag = err.diag
    primary = diag.message_primary or str(err).strip().splitlines()[0]
    message = primary + (f". Hint: {diag.message_hint}" if diag.message_hint else "")

    if state == "57014":  # query_canceled: statement_timeout or our watchdog
        return _timeout(timeout_seconds)
    if state == "25006":  # read_only_sql_transaction
        return QueryError(
            "read_only", f"Vita is read-only: this query tries to change data ({primary})."
        )
    if state == "42601":  # syntax_error
        line = column = None
        if diag.statement_position:
            line, column = line_and_column(sql, int(diag.statement_position))
            return QueryError(
                "syntax", f"Syntax error at line {line}, column {column}: {message}", line, column
            )
        return QueryError("syntax", f"Syntax error: {message}")
    if state in {"42P01", "42703", "42883", "3F000", "42704", "3D000"}:
        return QueryError("not_found", message)
    if state == "42501":
        return QueryError("permission", f"Permission denied: {message}")
    if state.startswith("08") or (isinstance(err, psycopg.OperationalError) and not state):
        return QueryError("connection", friendly_db_error(err, details))
    return QueryError("other", message)


_MYSQL_SYNTAX = re.compile(r"near '(?P<near>.*)' at line (?P<line>\d+)", re.DOTALL)


def _mysql_error(
    err: pymysql.err.MySQLError, details: ConnectionDetails, timeout_seconds: float
) -> QueryError:
    code = err.args[0] if err.args and isinstance(err.args[0], int) else 0
    text = str(err.args[1]) if len(err.args) > 1 else str(err)

    if code == 1064:
        match = _MYSQL_SYNTAX.search(text)
        if match:
            line = int(match["line"])
            near = match["near"].strip()[:80]
            return QueryError("syntax", f"Syntax error at line {line} near '{near}'", line, None)
        return QueryError("syntax", f"Syntax error: {text}")
    if code in {3024, 1969, 1317, 1028}:  # max_execution_time / MariaDB max_statement_time
        return _timeout(timeout_seconds)
    if code in {2013, 2006} and "timed out" in text.lower():  # client read_timeout
        return _timeout(timeout_seconds)
    if code in {1792, 1290}:  # READ ONLY transaction / --read-only server
        return QueryError(
            "read_only", f"Vita is read-only: this query tries to change data ({text})."
        )
    if code in {1146, 1054, 1049, 1305, 1109}:
        return QueryError("not_found", text)
    if code in {1142, 1143, 1044, 1227, 1370}:
        return QueryError("permission", f"Permission denied: {text}")
    if code in {1045, 2003, 2005, 2006, 2013}:
        return QueryError("connection", friendly_db_error(err, details))
    return QueryError("other", text)
