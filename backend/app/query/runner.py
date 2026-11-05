"""Run one read-only SQL query on a user database.

Safety layers:
1. validate.prepare_sql: one statement, read queries only (sqlglot).
2. A read-only transaction that is always rolled back.
3. Server-side timeout (Postgres statement_timeout / MySQL max_execution_time),
   plus a client-side guard so a slow network can't hang the backend.
4. At most limit + 1 rows are ever fetched:
   - Postgres: a server-side cursor; FETCH limit + 1, then the cursor is closed.
   - MySQL: the outermost LIMIT is capped at limit + 1 by validate.py. (PyMySQL's
     streaming cursor would read and discard *all* remaining rows when closed.)
"""

import threading
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Literal

from pymysql.constants import FIELD_TYPE

from app.engines import ConnectionDetails, create_engine_for
from app.query.errors import QueryError, line_and_column, translate_db_error
from app.query.serialize import to_json_value
from app.query.validate import PreparedQuery, prepare_sql

DEFAULT_LIMIT = 1000
MAX_LIMIT = 10_000
DEFAULT_TIMEOUT_SECONDS = 30
# Extra time the client-side guards wait before giving up on the server.
CLIENT_GRACE_SECONDS = 10

GenericType = Literal["number", "string", "datetime", "date", "boolean", "other"]


@dataclass(frozen=True)
class ResultColumn:
    name: str
    type: GenericType
    db_type: str


@dataclass(frozen=True)
class QueryResult:
    columns: list[ResultColumn]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    duration_ms: int


def run_query(
    details: ConnectionDetails,
    sql: str,
    limit: int = DEFAULT_LIMIT,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> QueryResult:
    """Validate and run one read-only query. Raises QueryError with a readable message."""
    limit = max(1, min(int(limit), MAX_LIMIT))
    prepared = prepare_sql(sql, details.db_type, fetch_limit=limit + 1)
    return execute_read_only(details, prepared, limit, timeout_seconds)


def execute_read_only(
    details: ConnectionDetails, prepared: PreparedQuery, limit: int, timeout_seconds: float
) -> QueryResult:
    """Run already-validated SQL. Public so tests can prove the database-side
    read-only layer works on its own, without the sqlglot check."""
    is_pg = details.db_type == "postgresql"
    engine = create_engine_for(details, query_timeout_seconds=timeout_seconds)
    started = time.perf_counter()
    try:
        raw = engine.raw_connection()
        try:
            dbapi_conn: Any = raw.dbapi_connection
            if is_pg:
                _begin_postgres(dbapi_conn, timeout_seconds)
            else:
                _begin_mysql(dbapi_conn, timeout_seconds)

            with _watchdog(dbapi_conn if is_pg else None, timeout_seconds + CLIENT_GRACE_SECONDS):
                description, fetched = _execute_and_fetch(dbapi_conn, prepared, limit + 1)
            columns = _columns(description, dbapi_conn, is_pg, fetched)
            dbapi_conn.rollback()
        finally:
            raw.close()
    except QueryError:
        raise
    except Exception as exc:
        error = translate_db_error(exc, details, prepared.sql, timeout_seconds)
        if error.kind == "syntax" and (prepared.streamable or prepared.sql != prepared.user_sql):
            # The position refers to the SQL we actually sent ("DECLARE ... FOR <sql>" on
            # Postgres, or MySQL SQL with a rewritten LIMIT). Find it in the user's SQL.
            error = _locate_syntax_error(details, prepared.user_sql, timeout_seconds) or error
        raise error from exc
    finally:
        engine.dispose()

    duration_ms = round((time.perf_counter() - started) * 1000)
    truncated = len(fetched) > limit
    rows = [[to_json_value(v) for v in row] for row in fetched[:limit]]
    return QueryResult(columns, rows, len(rows), truncated, duration_ms)


# ---------- transaction setup ----------


def _begin_postgres(conn: Any, timeout_seconds: float) -> None:
    with conn.cursor() as cur:  # psycopg opens the transaction (BEGIN) on the first statement
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute(f"SET LOCAL statement_timeout = {int(timeout_seconds * 1000)}")


def _begin_mysql(conn: Any, timeout_seconds: float) -> None:
    import pymysql

    with conn.cursor() as cur:
        try:
            cur.execute(f"SET SESSION max_execution_time = {int(timeout_seconds * 1000)}")
        except pymysql.err.MySQLError:  # MariaDB: different name, in seconds
            cur.execute(f"SET SESSION max_statement_time = {float(timeout_seconds)}")
        # Session level too: DDL in MySQL implicitly commits, and the next
        # transaction must still be read-only.
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute("START TRANSACTION READ ONLY")


@contextmanager
def _watchdog(pg_conn: Any | None, seconds: float) -> Iterator[None]:
    """Postgres: cancel the query from another thread if the server-side timeout didn't
    fire (e.g. the query changed statement_timeout with set_config()). MySQL relies
    on PyMySQL's read_timeout instead."""
    if pg_conn is None:
        yield
        return
    timer = threading.Timer(seconds, pg_conn.cancel_safe)
    timer.daemon = True
    timer.start()
    try:
        yield
    finally:
        timer.cancel()


def _execute_and_fetch(
    conn: Any, prepared: PreparedQuery, fetch_limit: int
) -> tuple[Sequence[Any] | None, list[Sequence[Any]]]:
    # psycopg server-side cursor when streamable
    cursor = conn.cursor(name="vita_query") if prepared.streamable else conn.cursor()
    try:
        cursor.execute(prepared.sql)  # no parameters: '%' and ':' in the SQL are left alone
        if cursor.description is None:  # statement returned no rows
            return None, []
        return cursor.description, list(cursor.fetchmany(fetch_limit))
    finally:
        cursor.close()


_PG_PREPARE_PREFIX = "PREPARE vita_syntax_check AS "


def _locate_syntax_error(
    details: ConnectionDetails, user_sql: str, timeout_seconds: float
) -> QueryError | None:
    """Ask the database to only *parse* the user's SQL (PREPARE never executes it), so the
    syntax error position matches what the user wrote. Returns None if it parses fine."""
    engine = create_engine_for(details, query_timeout_seconds=timeout_seconds)
    try:
        raw = engine.raw_connection()
        try:
            conn: Any = raw.dbapi_connection
            with conn.cursor() as cur:
                if details.db_type == "postgresql":
                    cur.execute(_PG_PREPARE_PREFIX + user_sql)
                else:
                    cur.execute("PREPARE vita_syntax_check FROM %s", (user_sql,))
            conn.rollback()
        finally:
            raw.close()
    except Exception as exc:
        orig: Any = getattr(exc, "orig", None) or exc
        position = getattr(getattr(orig, "diag", None), "statement_position", None)
        if details.db_type == "postgresql" and position:
            # Shift the position past "PREPARE ... AS ".
            line, column = line_and_column(user_sql, int(position) - len(_PG_PREPARE_PREFIX))
            message = orig.diag.message_primary or str(orig)
            return QueryError(
                "syntax", f"Syntax error at line {line}, column {column}: {message}", line, column
            )
        error = translate_db_error(exc, details, user_sql, timeout_seconds)
        return error if error.kind == "syntax" else None
    finally:
        engine.dispose()
    return None


# ---------- column types ----------

_PG_NUMBER = {"int2", "int4", "int8", "numeric", "float4", "float8", "oid", "money"}
_PG_STRING = {"text", "varchar", "bpchar", "char", "name", "citext"}
_PG_GENERIC: dict[str, GenericType] = {
    **{t: "number" for t in _PG_NUMBER if t != "money"},
    **dict.fromkeys(_PG_STRING, "string"),
    "money": "string",
    "timestamp": "datetime",
    "timestamptz": "datetime",
    "date": "date",
    "bool": "boolean",
}

_MYSQL_NAMES = {
    value: name
    for name, value in vars(FIELD_TYPE).items()
    if name.isupper() and isinstance(value, int) and name not in {"CHAR", "INTERVAL"}
}
_MYSQL_GENERIC: dict[str, GenericType] = {
    **dict.fromkeys(
        ("DECIMAL", "NEWDECIMAL", "TINY", "SHORT", "LONG", "FLOAT", "DOUBLE", "LONGLONG", "INT24"),
        "number",
    ),
    "YEAR": "number",
    **dict.fromkeys(
        ("VARCHAR", "VAR_STRING", "STRING", "ENUM", "SET"),
        "string",
    ),
    **dict.fromkeys(("TINY_BLOB", "MEDIUM_BLOB", "LONG_BLOB", "BLOB"), "string"),
    "DATETIME": "datetime",
    "TIMESTAMP": "datetime",
    "DATE": "date",
    "NEWDATE": "date",
}  # fmt: skip


def _pg_type_name(conn: Any, oid: int) -> str:
    info = conn.adapters.types.get(oid)
    if info is None:
        return f"oid:{oid}"
    return f"{info.name}[]" if oid == info.array_oid else str(info.name)


def _columns(
    description: Sequence[Any] | None, conn: Any, is_pg: bool, rows: list[Sequence[Any]]
) -> list[ResultColumn]:
    """Column names and types from the cursor description (rows are the raw driver values)."""
    if not description:
        return []
    columns: list[ResultColumn] = []
    for index, col in enumerate(description):
        name, type_code = col[0], col[1]
        if is_pg:
            db_type = _pg_type_name(conn, type_code)
            generic: GenericType = _PG_GENERIC.get(db_type, "other")
        else:
            db_type = _MYSQL_NAMES.get(type_code, str(type_code)).lower()
            generic = _MYSQL_GENERIC.get(db_type.upper(), "other")
            # MySQL reports TEXT and BLOB (and CHAR / BINARY) with the same type codes;
            # binary columns come back as bytes.
            if generic == "string" and any(isinstance(r[index], bytes) for r in rows[:100]):
                generic = "other"
        columns.append(ResultColumn(name=str(name), type=generic, db_type=db_type))
    return columns
