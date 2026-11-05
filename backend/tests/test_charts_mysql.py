"""Chart queries on a real MySQL server. Skipped unless VITA_TEST_MYSQL_HOST is set.

Run against a throwaway container, e.g.:
    docker run -d --name vita-tmp-mysql --network <compose network> \
        -e MYSQL_ROOT_PASSWORD=<pw> -e MYSQL_DATABASE=vita_check mysql:8.4
    docker compose exec -e VITA_TEST_MYSQL_HOST=vita-tmp-mysql \
        -e VITA_TEST_MYSQL_PASSWORD=<pw> backend pytest tests/test_charts_mysql.py
"""

import os
from collections import Counter
from collections.abc import Iterator
from datetime import date, datetime, timedelta
from typing import Any

import pymysql
import pytest

from app.charts import build_chart_query
from app.engines import ConnectionDetails
from app.models import Dataset, DatasetColumn, DatasetMetric
from app.query import run_query
from app.schemas.charts import ChartQuery, VizType

HOST = os.environ.get("VITA_TEST_MYSQL_HOST")
pytestmark = pytest.mark.skipif(not HOST, reason="VITA_TEST_MYSQL_HOST not set")

DATABASE = "vita_check"
TABLE = "order lines"  # awkward name on purpose

# (order date, created at, status, amount): around week/year/quarter edges.
ROWS: list[tuple[date, datetime, str | None, float]] = [
    (date(2024, 12, 29), datetime(2024, 12, 29, 23, 30), "paid", 10.0),  # Sunday
    (date(2024, 12, 30), datetime(2024, 12, 30, 0, 0), "paid", 20.0),  # Monday
    (date(2025, 1, 1), datetime(2025, 1, 1, 12, 0), "open", 5.5),  # Wednesday
    (date(2025, 1, 5), datetime(2025, 1, 5, 8, 15), "paid", 7.25),  # Sunday
    (date(2025, 1, 6), datetime(2025, 1, 6, 9, 0), "it's \"odd\"", 1.0),  # Monday
    (date(2025, 3, 31), datetime(2025, 3, 31, 23, 59, 59), "100% off_x", 3.0),
    (date(2025, 4, 1), datetime(2025, 4, 1, 0, 0, 1), None, 4.0),
    (date(2025, 12, 31), datetime(2025, 12, 31, 23, 59, 59), "paid", 50.0),
]


def bucket(day: date, grain: str) -> date:
    match grain:
        case "day":
            return day
        case "week":
            return day - timedelta(days=day.weekday())
        case "month":
            return day.replace(day=1)
        case "quarter":
            return date(day.year, 3 * ((day.month - 1) // 3) + 1, 1)
        case _:
            return date(day.year, 1, 1)


@pytest.fixture(scope="module")
def details() -> Iterator[ConnectionDetails]:
    password = os.environ.get("VITA_TEST_MYSQL_PASSWORD", "")
    conn = pymysql.connect(host=HOST, user="root", password=password, database=DATABASE, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS `{TABLE}`")
            cur.execute(
                f"CREATE TABLE `{TABLE}` (`order date` DATE, `created at` DATETIME, "
                "`status` VARCHAR(40), `select` DECIMAL(10, 2))"
            )
            cur.executemany(f"INSERT INTO `{TABLE}` VALUES (%s, %s, %s, %s)", ROWS)
        yield ConnectionDetails(
            db_type="mysql", host=HOST or "", port=3306, database=DATABASE, username="root",
            password=password,
        )  # fmt: skip
    finally:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS `{TABLE}`")
        conn.close()


def dataset() -> Dataset:
    def col(name: str, kind: str, dimension: bool = False) -> DatasetColumn:
        return DatasetColumn(
            name=name, generic_type=kind, generic_type_override=None,
            is_temporal=kind in ("date", "datetime"), is_dimension=dimension,
            is_hidden=False, is_missing=False,
        )  # fmt: skip

    return Dataset(
        kind="table",
        schema=DATABASE,
        table_name=TABLE,
        main_time_column="order date",
        columns=[
            col("order date", "date"),
            col("created at", "datetime"),
            col("status", "string", dimension=True),
            col("select", "number"),
        ],
        metrics=[
            DatasetMetric(name="count", expression="COUNT(*)", is_builtin=True),
            DatasetMetric(name="total", expression="SUM(`select`)", is_builtin=False),
        ],
    )


def run(details: ConnectionDetails, viz: VizType, **query: Any) -> list[list[Any]]:
    built = build_chart_query(dataset(), "mysql", viz, ChartQuery(dataset_id=1, **query),
                              today=date(2025, 1, 10))  # fmt: skip
    return run_query(details, built.sql, limit=built.row_limit).rows


@pytest.mark.parametrize("column", ["order date", "created at"])
@pytest.mark.parametrize("grain", ["day", "week", "month", "quarter", "year"])
def test_grains(details: ConnectionDetails, grain: str, column: str) -> None:
    rows = run(details, "line", metrics=["count"], time={"column": column, "grain": grain})
    expected = Counter(bucket(r[0], grain).isoformat() for r in ROWS)
    assert rows == [[day, n] for day, n in sorted(expected.items())]


def test_week_crosses_the_year_boundary(details: ConnectionDetails) -> None:
    rows = run(details, "line", metrics=["count"], time={"grain": "week"})
    # Mon 2024-12-30 .. Sun 2025-01-05 is one week; Sun 2024-12-29 belongs to the week before.
    assert rows[:3] == [["2024-12-23", 1], ["2024-12-30", 3], ["2025-01-06", 1]]


@pytest.mark.parametrize(
    ("filter_", "expected"),
    [
        ({"column": "status", "operator": "=", "value": "paid"}, 4),
        ({"column": "status", "operator": "!=", "value": "paid"}, 4),  # includes the NULL row
        ({"column": "select", "operator": ">", "value": 7.25}, 3),
        ({"column": "select", "operator": ">=", "value": "7.25"}, 4),
        ({"column": "select", "operator": "<", "value": 4}, 2),
        ({"column": "select", "operator": "<=", "value": 4}, 3),
        ({"column": "status", "operator": "IN", "value": ["paid", "open"]}, 5),
        ({"column": "status", "operator": "NOT IN", "value": ["paid"]}, 4),  # includes NULL
        ({"column": "status", "operator": "NOT IN", "value": ["paid", None]}, 3),  # excludes NULL
        ({"column": "status", "operator": "IN", "value": ["open", None]}, 2),
        ({"column": "select", "operator": "!=", "value": 4}, 7),
        ({"column": "order date", "operator": "BETWEEN", "value": ["2025-01-01", "2025-03-31"]}, 4),
        ({"column": "created at", "operator": ">", "value": "2025-03-31T23:59:58"}, 3),
        ({"column": "status", "operator": "IS NULL"}, 1),
        ({"column": "status", "operator": "IS NOT NULL"}, 7),
        ({"column": "status", "operator": "LIKE", "value": "PAI"}, 4),
        ({"column": "status", "operator": "LIKE", "value": "0% off_"}, 1),  # literal % and _
        ({"column": "status", "operator": "LIKE", "value": "0_ off"}, 0),
        ({"column": "status", "operator": "=", "value": "it's \"odd\""}, 1),
        ({"column": "status", "operator": "=", "value": "'; DROP TABLE `order lines`; --"}, 0),
        ({"column": "status", "operator": "LIKE", "value": "\\"}, 0),
    ],
)  # fmt: skip
def test_filters(details: ConnectionDetails, filter_: dict[str, Any], expected: int) -> None:
    assert run(details, "big_number", metrics=["count"], filters=[filter_]) == [[expected]]


def test_table_survives_injection_attempts(details: ConnectionDetails) -> None:
    run(details, "big_number", metrics=["count"],
        filters=[{"column": "status", "operator": "IN", "value": ["x'); DROP TABLE `order lines`; --"]}])  # fmt: skip
    assert run(details, "big_number", metrics=["count"]) == [[len(ROWS)]]


def test_top_series_join_with_null(details: ConnectionDetails) -> None:
    # Totals per status: paid 87.25, open 5.5, NULL 4.0, "100% off_x" 3.0, it's "odd" 1.0
    rows = run(details, "bar", metrics=["total"], time={"grain": "year"}, series="status", series_limit=2)
    assert rows == [["2024-01-01", "paid", 30.0], ["2025-01-01", "open", 5.5], ["2025-01-01", "paid", 57.25]]
    rows = run(details, "bar", metrics=["total"], time={"grain": "year"}, series="status", series_limit=3)
    assert {r[1] for r in rows} == {"paid", "open", None}  # the NULL series is joined too


def test_range_start_snaps_to_the_grain(details: ConnectionDetails) -> None:
    # today = 2025-01-10; last 7 days starts 2025-01-03, snapped to Monday 2024-12-30.
    rows = run(details, "line", metrics=["count"], time={"grain": "week", "range": {"kind": "last_7_days"}})
    assert rows == [["2024-12-30", 3], ["2025-01-06", 1]]


def test_time_range_and_saved_metric(details: ConnectionDetails) -> None:
    # today = 2025-01-10: last 7 days = 2025-01-03 .. 2025-01-10
    assert run(details, "big_number", metrics=["total"], time={"range": {"kind": "last_7_days"}}) == [[8.25]]
    assert run(details, "big_number", metrics=["count"], time={"range": {"kind": "last_year"}}) == [[2]]


def test_dimensions_order_and_limit(details: ConnectionDetails) -> None:
    rows = run(details, "table", metrics=["count", {"column": "select", "aggregate": "MAX"}],
               dimensions=["status"], order_by={"by": "status", "descending": False}, row_limit=3)  # fmt: skip
    assert rows == [[None, 1, 4.0], ["100% off_x", 1, 3.0], ["it's \"odd\"", 1, 1.0]]
