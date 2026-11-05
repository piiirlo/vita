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
    kind: QueryErrorKind
    message: str
    line: int | None = None
    column: int | None = None

    def __str__(self) -> str:
        return self.message


def read_only_error(what: str) -> QueryError:
    return QueryError(
        "read_only", f"Vita is read-only: {what} statements are not allowed. Only read queries can run."
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
        return _postgres_error(orig, details, sql, timeout_seconds)
    if isinstance(orig, pymysql.err.MySQLError):
        return _mysql_error(orig, details, timeout_seconds)
    if isinstance(orig, (TypeError, FileNotFoundError, OSError)):
        return QueryError("connection", friendly_db_error(orig, details))
    return QueryError("other", friendly_db_error(orig, details))


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
            return QueryError("syntax", f"Syntax error at line {line}, column {column}: {message}", line, column)
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
        return QueryError("read_only", f"Vita is read-only: this query tries to change data ({text}).")
    if code in {1146, 1054, 1049, 1305, 1109}:
        return QueryError("not_found", text)
    if code in {1142, 1143, 1044, 1227, 1370}:
        return QueryError("permission", f"Permission denied: {text}")
    if code in {1045, 2003, 2005, 2006, 2013}:
        return QueryError("connection", friendly_db_error(err, details))
    return QueryError("other", text)
