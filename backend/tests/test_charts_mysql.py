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
    (date(2025, 1, 6), datetime(2025, 1, 6, 9, 0), 'it\'s "odd"', 1.0),  # Monday
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
    conn = pymysql.connect(
        host=HOST, user="root", password=password, database=DATABASE, autocommit=True
    )
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
    rows = run_query(details, built.sql, limit=built.row_limit).rows
    # Like the API: drop the rows probe (MIN of the time column) of totals over a time range.
    return [row[:-1] for row in rows if row[-1] is not None] if built.rows_probe else rows


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
    rows = run(
        details, "bar", metrics=["total"], time={"grain": "year"}, series="status", series_limit=2
    )
    assert rows == [
        ["2024-01-01", "paid", 30.0],
        ["2025-01-01", "open", 5.5],
        ["2025-01-01", "paid", 57.25],
    ]
    rows = run(
        details, "bar", metrics=["total"], time={"grain": "year"}, series="status", series_limit=3
    )
    assert {r[1] for r in rows} == {"paid", "open", None}  # the NULL series is joined too


def test_range_start_snaps_to_the_grain(details: ConnectionDetails) -> None:
    # today = 2025-01-10; last 7 days starts 2025-01-03, snapped to Monday 2024-12-30.
    rows = run(
        details, "line", metrics=["count"], time={"grain": "week", "range": {"kind": "last_7_days"}}
    )
    assert rows == [["2024-12-30", 3], ["2025-01-06", 1]]


def test_time_range_and_saved_metric(details: ConnectionDetails) -> None:
    # today = 2025-01-10: last 7 days = 2025-01-03 .. 2025-01-10
    assert run(
        details, "big_number", metrics=["total"], time={"range": {"kind": "last_7_days"}}
    ) == [[8.25]]
    assert run(details, "big_number", metrics=["count"], time={"range": {"kind": "last_year"}}) == [
        [2]
    ]


def test_dimensions_order_and_limit(details: ConnectionDetails) -> None:
    rows = run(details, "table", metrics=["count", {"column": "select", "aggregate": "MAX"}],
               dimensions=["status"], order_by={"by": "status", "descending": False}, row_limit=3)  # fmt: skip
    assert rows == [[None, 1, 4.0], ["100% off_x", 1, 3.0], ['it\'s "odd"', 1, 1.0]]


# ---------- Part 11: more chart types on MySQL ----------


def test_pivot_totals_with_union_all(details: ConnectionDetails) -> None:
    """MySQL has no GROUPING SETS: one UNION ALL branch per level; AVG totals still right."""
    avg = {"column": "select", "aggregate": "AVG", "label": "avg"}
    rows = run(details, "pivot_table", metrics=[avg, "count"], dimensions=["status"],
               column_dimensions=["order date"], totals=True, row_limit=1000)  # fmt: skip
    got = {(r[0], r[1], r[2], r[3]): (float(r[4]), r[5]) for r in rows}
    amounts = [r[3] for r in ROWS]
    assert got[(None, None, 0, 0)][0] == pytest.approx(sum(amounts) / len(amounts))
    assert got[(None, None, 0, 0)][1] == len(ROWS)
    paid = [r[3] for r in ROWS if r[2] == "paid"]
    assert got[("paid", None, 1, 0)][0] == pytest.approx(sum(paid) / len(paid))
    assert got[("paid", None, 1, 0)][1] == len(paid)
    # A real NULL status is a row of its own (level 1), not the total (level 0).
    assert got[(None, None, 1, 0)] == (4.0, 1)
    assert got[(None, "2025-01-01", 0, 1)] == (5.5, 1)
    assert got[("paid", "2024-12-29", 1, 1)] == (10.0, 1)
    assert len(got) == len(rows)


def test_treemap_and_funnel_and_gauge(details: ConnectionDetails) -> None:
    rows = run(details, "treemap", metrics=["total"], dimensions=["status", "order date"],
               series_limit=1)  # fmt: skip
    inside = [r for r in rows if r[2] == 0]
    assert {r[0] for r in inside} == {"paid"}
    assert sum(r[3] for r in inside) == pytest.approx(87.25)
    [other] = [r for r in rows if r[2] == 1]
    assert other[:3] == [None, None, 1] and other[3] == pytest.approx(5.5 + 4.0 + 3.0 + 1.0)

    funnel = run(details, "funnel", metrics=["count"], dimensions=["status"])
    assert funnel[0] == ["paid", 4]
    assert run(details, "gauge", metrics=["total"]) == [[pytest.approx(100.75)]]
    assert run(details, "gauge", metrics=["total"], time={"range": {"kind": "last_7_days"}}) == [
        [8.25]
    ]


# ---------- Part 11 round 2 on MySQL: bins, time parts, date buckets ----------

BIN_TABLE = "bin values"
BIN_ROWS: list[tuple[float | None, datetime]] = [
    (-3.5, datetime(2026, 11, 2, 8, 15)),  # Monday
    (-1.0, datetime(2026, 11, 2, 8, 45)),
    (0.0, datetime(2026, 11, 3, 13, 0)),  # Tuesday
    (0.5, datetime(2026, 11, 8, 23, 59)),  # Sunday
    (2.0, datetime(2026, 11, 8, 0, 0)),
    (2.0, datetime(2026, 3, 1, 12, 0)),  # Sunday
    (None, datetime(2026, 3, 1, 12, 30)),
]


@pytest.fixture(scope="module")
def bins_details(details: ConnectionDetails) -> Iterator[ConnectionDetails]:
    conn = pymysql.connect(host=HOST, user="root", password=details.password, database=DATABASE,
                           autocommit=True)  # fmt: skip
    try:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS `{BIN_TABLE}`")
            cur.execute(f"CREATE TABLE `{BIN_TABLE}` (`x` DECIMAL(10, 2), `at` DATETIME)")
            cur.executemany(f"INSERT INTO `{BIN_TABLE}` VALUES (%s, %s)", BIN_ROWS)
        yield details
    finally:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS `{BIN_TABLE}`")
        conn.close()


def bins_dataset() -> Dataset:
    return Dataset(
        kind="table",
        schema=DATABASE,
        table_name=BIN_TABLE,
        main_time_column="at",
        columns=[
            DatasetColumn(
                name="x",
                generic_type="number",
                generic_type_override=None,
                is_temporal=False,
                is_dimension=False,
                is_hidden=False,
                is_missing=False,
            ),
            DatasetColumn(
                name="at",
                generic_type="datetime",
                generic_type_override=None,
                is_temporal=True,
                is_dimension=False,
                is_hidden=False,
                is_missing=False,
            ),
        ],
        metrics=[DatasetMetric(name="count", expression="COUNT(*)", is_builtin=True)],
    )


def run_bins(details: ConnectionDetails, viz: VizType, **query: Any) -> list[list[Any]]:
    built = build_chart_query(bins_dataset(), "mysql", viz, ChartQuery(dataset_id=1, **query),
                              today=date(2026, 11, 10))  # fmt: skip
    return run_query(details, built.sql, limit=built.row_limit).rows


def floats(rows: list[list[Any]]) -> list[list[float | None]]:
    return [[None if v is None else float(v) for v in r] for r in rows]


def test_histogram_bins_on_mysql(bins_details: ConnectionDetails) -> None:
    rows = floats(
        run_bins(bins_details, "histogram", metrics=["count"], bins={"column": "x", "count": 11})
    )
    assert rows[0] == [None, None, None, 1.0]  # the NULL value
    got = {int(r[0]): (r[1], r[2], r[3]) for r in rows[1:]}  # type: ignore[arg-type]
    assert got == {0: (-3.5, -3.0, 1.0), 5: (-1.0, -0.5, 1.0), 7: (0.0, 0.5, 1.0),
                   8: (0.5, 1.0, 1.0), 10: (1.5, 2.0, 2.0)}  # fmt: skip
    width = floats(
        run_bins(bins_details, "histogram", metrics=["count"], bins={"column": "x", "width": 2})
    )
    assert width == [
        [None, None, None, 1.0],
        [-2.0, -4.0, -2.0, 1.0],
        [-1.0, -2.0, 0.0, 1.0],
        [0.0, 0.0, 2.0, 2.0],
        [1.0, 2.0, 4.0, 2.0],
    ]


def test_time_parts_heatmap_on_mysql(bins_details: ConnectionDetails) -> None:
    rows = run_bins(
        bins_details, "heatmap", metrics=["count"], dimensions=["at@day_of_week", "at@hour_of_day"]
    )
    # Monday = 1 ... Sunday = 7, like Postgres ISODOW.
    assert rows == [[1, 8, 2], [2, 13, 1], [7, 0, 1], [7, 12, 2], [7, 23, 1]]


def test_pivot_date_buckets_on_mysql(bins_details: ConnectionDetails) -> None:
    rows = run_bins(bins_details, "pivot_table", metrics=["count"], dimensions=["at@month"],
                    column_dimensions=["at@day_of_week"], totals=True, row_limit=1000)  # fmt: skip
    got = {(r[0], r[1], r[2], r[3]): r[4] for r in rows}
    assert got[("2026-03-01", 7, 1, 1)] == 2
    assert got[("2026-11-01", None, 1, 0)] == 5
    assert got[(None, 1, 0, 1)] == 2
    assert got[(None, None, 0, 0)] == 7


# ---------- Part 13: year numbers, text dates, raw values, line dimensions ----------

GAMES_TABLE = "games"
# (year as BIGINT, day-first dates as text with mixed separators, region, sales)
GAMES_ROWS: list[tuple[int | None, str | None, str, float]] = [
    (2006, "9/11/2006", "NA", 41.5),
    (2006, "13-06-2006", "EU", 29.0),
    (2008, "1.2.2008", "NA", 15.9),
    (2009, "31/12/2009", "JP", 3.3),
    (None, "30/02/2009", "EU", 1.0),  # no year; an impossible date
    (1985, "not a date", "NA", 29.1),
]


@pytest.fixture(scope="module")
def games_details(details: ConnectionDetails) -> Iterator[ConnectionDetails]:
    conn = pymysql.connect(host=HOST, user="root", password=details.password, database=DATABASE,
                           autocommit=True)  # fmt: skip
    try:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS `{GAMES_TABLE}`")
            cur.execute(
                f"CREATE TABLE `{GAMES_TABLE}` (`Year` BIGINT, `day` VARCHAR(20), "
                "`region` VARCHAR(10), `sales` DECIMAL(10, 2))"
            )
            cur.executemany(f"INSERT INTO `{GAMES_TABLE}` VALUES (%s, %s, %s, %s)", GAMES_ROWS)
        yield details
    finally:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS `{GAMES_TABLE}`")
        conn.close()


def games_dataset() -> Dataset:
    def col(name: str, kind: str, **extra: Any) -> DatasetColumn:
        return DatasetColumn(
            name=name, generic_type=kind, generic_type_override=None, is_hidden=False,
            is_missing=False, **{"is_temporal": False, "is_dimension": False, **extra},
        )  # fmt: skip

    return Dataset(
        kind="table", schema=DATABASE, table_name=GAMES_TABLE, main_time_column="Year",
        columns=[
            col("Year", "number", is_temporal=True, time_kind="year_number"),
            col("day", "string", is_temporal=True, time_kind="text_date", text_date_format="dmy"),
            col("region", "string", is_dimension=True),
            col("sales", "number"),
        ],
        metrics=[DatasetMetric(name="count", expression="COUNT(*)", is_builtin=True)],
    )  # fmt: skip


def run_games(details: ConnectionDetails, viz: VizType, **query: Any) -> list[list[Any]]:
    built = build_chart_query(games_dataset(), "mysql", viz, ChartQuery(dataset_id=1, **query),
                              today=date(2009, 6, 1))  # fmt: skip
    rows = run_query(details, built.sql, limit=built.row_limit).rows
    return [row[:-1] for row in rows if row[-1] is not None] if built.rows_probe else rows


def test_year_numbers_on_mysql(games_details: ConnectionDetails) -> None:
    rows = run_games(games_details, "line", metrics=["count"], time={"grain": "year"})
    assert rows == [[None, 1], ["1985-01-01", 1], ["2006-01-01", 2], ["2008-01-01", 1],
                    ["2009-01-01", 1]]  # fmt: skip
    # Time range on the year: this year (2009) and the no-data probe.
    total = run_games(games_details, "big_number", metrics=["count"],
                      time={"range": {"kind": "this_year"}})  # fmt: skip
    assert total == [[1]]
    none = run_games(games_details, "big_number", metrics=["count"],
                     time={"range": {"kind": "custom", "start": "1990-01-01",
                                     "end": "1990-12-31"}})  # fmt: skip
    assert none == []


def test_text_dates_on_mysql(games_details: ConnectionDetails) -> None:
    rows = run_games(games_details, "bar", metrics=["count"],
                     time={"column": "day", "grain": "month"})  # fmt: skip
    # "30/02/2009" and "not a date" read as no date (NULL), never an error.
    assert rows == [[None, 2], ["2006-06-01", 1], ["2006-11-01", 1], ["2008-02-01", 1],
                    ["2009-12-01", 1]]  # fmt: skip


def test_raw_values_and_line_dimensions_on_mysql(games_details: ConnectionDetails) -> None:
    raw = run_games(games_details, "line", metrics=["count"],
                    time={"column": "day", "grain": "raw"})  # fmt: skip
    assert [r[0] for r in raw] == [None, "2006-06-13", "2006-11-09", "2008-02-01", "2009-12-31"]
    by_region = run_games(games_details, "line", metrics=["count"], dimensions=["region"])
    assert by_region == [["EU", 2], ["JP", 1], ["NA", 3]]  # ordered by the category
