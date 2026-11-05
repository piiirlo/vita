"""Query engine pieces that don't need a database: SQL validation (incl. MySQL), serialization."""

import uuid
from datetime import date, datetime, time
from decimal import Decimal

import pytest

from app.query import QueryError
from app.query.errors import line_and_column
from app.query.serialize import to_json_value
from app.query.validate import prepare_sql


def prepare(sql: str, db_type: str = "mysql", fetch_limit: int = 1001) -> str:
    return prepare_sql(sql, db_type, fetch_limit).sql


def error(sql: str, db_type: str = "mysql") -> QueryError:
    with pytest.raises(QueryError) as exc_info:
        prepare_sql(sql, db_type, 1001)
    return exc_info.value


# ---------- MySQL LIMIT capping ----------


def test_mysql_adds_limit_when_missing() -> None:
    assert prepare("SELECT * FROM family") == "SELECT * FROM family LIMIT 1001"


def test_mysql_lowers_a_large_limit() -> None:
    assert prepare("SELECT * FROM family LIMIT 5000000") == "SELECT * FROM family LIMIT 1001"


def test_mysql_keeps_a_smaller_limit_untouched() -> None:
    sql = "SELECT * FROM family LIMIT 10"
    assert prepare(sql) == sql
    assert prepare("SELECT * FROM t LIMIT 5, 20") == "SELECT * FROM t LIMIT 5, 20"


def test_mysql_limit_on_union_and_offset() -> None:
    assert prepare("SELECT a FROM t UNION SELECT b FROM u").endswith("LIMIT 1001")
    assert prepare("SELECT * FROM t LIMIT 5, 99999") == "SELECT * FROM t LIMIT 1001 OFFSET 5"


def test_mysql_show_and_describe_are_not_rewritten() -> None:
    assert prepare("SHOW TABLES") == "SHOW TABLES"
    assert prepare("DESCRIBE family;") == "DESCRIBE family"


def test_postgres_sql_is_sent_unchanged_and_streamed() -> None:
    prepared = prepare_sql("SELECT *\nFROM t  ; -- bye", "postgresql", 1001)
    assert prepared.sql == "SELECT *\nFROM t"
    assert prepared.streamable is True
    assert prepare_sql("SHOW search_path", "postgresql", 1001).streamable is False


# ---------- read-only checks (MySQL dialect) ----------


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO t VALUES (1)",
        "REPLACE INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "DELETE FROM t",
        "CREATE TABLE x (a INT)",
        "DROP TABLE t",
        "TRUNCATE TABLE t",
        "ALTER TABLE t ADD COLUMN b INT",
        "LOCK TABLES t READ",
        "KILL 5",
        "EXPLAIN DELETE FROM t",
        "SELECT * FROM t FOR UPDATE",
    ],
)
def test_mysql_writes_rejected(sql: str) -> None:
    assert error(sql).kind == "read_only"


@pytest.mark.parametrize("sql", ["SET SESSION max_execution_time = 0", "USE other_db", "COMMIT"])
def test_mysql_session_and_transaction_statements_rejected(sql: str) -> None:
    assert error(sql).kind in {"not_allowed", "read_only"}


def test_mysql_multiple_statements() -> None:
    assert error("SELECT 1; DROP TABLE t").kind == "multiple_statements"


def test_mysql_syntax_error_has_position() -> None:
    err = error("SELECT *\nFROM t\nWHERE")
    assert (err.kind, err.line, err.column) == ("syntax", 3, 5)
    assert "incomplete WHERE clause" in err.message


def test_line_and_column() -> None:
    sql = "SELECT 1\nFROM t\nWHERE x"
    assert line_and_column(sql, 1) == (1, 1)
    assert line_and_column(sql, 10) == (2, 1)
    assert line_and_column(sql, 22) == (3, 6)


# ---------- serialization ----------


def test_to_json_value() -> None:
    assert to_json_value(None) is None
    assert to_json_value(Decimal("12.50")) == 12.5
    assert to_json_value(Decimal("42")) == 42
    assert to_json_value(Decimal("12345678901234567890.123")) == "12345678901234567890.123"
    assert to_json_value(Decimal("NaN")) == "NaN"
    assert to_json_value(float("inf")) == "inf"
    assert to_json_value(datetime(2025, 1, 2, 3, 4, 5)) == "2025-01-02T03:04:05"
    assert to_json_value(date(2025, 1, 2)) == "2025-01-02"
    assert to_json_value(time(12, 30)) == "12:30:00"
    u = uuid.uuid4()
    assert to_json_value(u) == str(u)
    assert to_json_value(b"\x00\xff") == "0x00ff"
    assert to_json_value(memoryview(b"\x01")) == "0x01"
    assert to_json_value(bytes(200)).endswith("…")
    assert to_json_value({"a": [Decimal("1.5"), None]}) == {"a": [1.5, None]}
