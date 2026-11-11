"""Chart query builder without a database: generated SQL text (both dialects), time ranges,
validation."""

from datetime import date
from typing import Any

import pytest

from app.charts import build_chart_query
from app.charts.timerange import time_bounds
from app.models import Dataset, DatasetColumn, DatasetMetric
from app.query import QueryError
from app.schemas.charts import ChartQuery, TimeRange, VizType

PG, MY = "postgresql", "mysql"
TODAY = date(2026, 3, 15)


def col(name: str, kind: str, **flags: bool) -> DatasetColumn:
    return DatasetColumn(
        name=name,
        generic_type=kind,
        generic_type_override=None,
        is_temporal=flags.get("temporal", kind in ("date", "datetime")),
        is_dimension=flags.get("dimension", kind == "string"),
        is_hidden=flags.get("hidden", False),
        is_missing=flags.get("missing", False),
    )


def dataset(kind: str = "table") -> Dataset:
    return Dataset(
        kind=kind,
        schema="sales" if kind == "table" else None,
        table_name="Order Lines" if kind == "table" else None,
        sql="SELECT * FROM sales.lines" if kind == "sql" else None,
        main_time_column="order_date",
        columns=[
            col("order_date", "date"),
            col("created at", "datetime"),
            col("status", "string"),
            col("select", "string"),  # reserved word
            col("amount", "number"),
            col("is_paid", "boolean", dimension=True),
            col("secret", "string", hidden=True),
            col("gone", "string", missing=True),
            col("note", "string", dimension=False),
        ],
        metrics=[
            DatasetMetric(name="count", expression="COUNT(*)", is_builtin=True),
            DatasetMetric(name="revenue", expression="SUM(amount)", is_builtin=False),
        ],
    )


def sql(
    query: dict[str, Any], db_type: str = PG, viz: VizType = "table", kind: str = "table"
) -> str:
    built = build_chart_query(
        dataset(kind), db_type, viz, ChartQuery(dataset_id=1, **query), today=TODAY
    )
    return " ".join(built.sql.split())  # one line, single spaces


def error(query: dict[str, Any], viz: VizType = "table", db_type: str = PG) -> str:
    with pytest.raises(QueryError) as info:
        sql(query, db_type, viz)
    assert info.value.kind == "invalid"
    return info.value.message


# ---------- time grains ----------


@pytest.mark.parametrize(
    ("grain", "expected"),
    [
        ("day", "CAST(DATE_TRUNC('day', \"order_date\") AS DATE)"),
        ("week", "CAST(DATE_TRUNC('week', \"order_date\") AS DATE)"),
        ("month", "CAST(DATE_TRUNC('month', \"order_date\") AS DATE)"),
        ("quarter", "CAST(DATE_TRUNC('quarter', \"order_date\") AS DATE)"),
        ("year", "CAST(DATE_TRUNC('year', \"order_date\") AS DATE)"),
    ],
)
def test_postgres_grains(grain: str, expected: str) -> None:
    text = sql({"metrics": ["count"], "time": {"grain": grain}}, PG, "line")
    assert text.startswith(f'SELECT {expected} AS "order_date", COUNT(*) AS "count"')
    assert f"GROUP BY {expected}" in text  # the expression, not the alias


@pytest.mark.parametrize(
    ("grain", "expected"),
    [
        ("day", "DATE(`created at`)"),
        ("week", "DATE(DATE_SUB(`created at`, INTERVAL (WEEKDAY(`created at`)) DAY))"),
        ("month", "DATE(DATE_SUB(`created at`, INTERVAL (DAYOFMONTH(`created at`) - 1) DAY))"),
        (
            "quarter",
            "MAKEDATE(YEAR(`created at`), 1) + INTERVAL ( QUARTER(`created at`) - 1 ) QUARTER",
        ),
        ("year", "MAKEDATE(YEAR(`created at`), 1)"),
    ],
)
def test_mysql_grains(grain: str, expected: str) -> None:
    text = sql({"metrics": ["count"], "time": {"column": "created at", "grain": grain}}, MY, "line")
    assert text.startswith(f"SELECT {expected} AS `created at`, COUNT(*) AS `count`")
    assert f"GROUP BY {expected}" in text


# ---------- query shape ----------


def test_full_query_shape_postgres() -> None:
    text = sql(
        {
            "metrics": ["revenue", {"column": "amount", "aggregate": "AVG"}],
            "dimensions": ["status", "select"],
            "filters": [{"column": "amount", "operator": ">", "value": 10}],
            "order_by": {"by": "AVG(amount)", "descending": False},
            "row_limit": 50,
        }
    )
    assert text == (
        'SELECT "status", "select", SUM(amount) AS "revenue", AVG("amount") AS "AVG(amount)" '
        'FROM "sales"."Order Lines" WHERE "amount" > 10 GROUP BY "status", "select" '
        'ORDER BY "AVG(amount)" ASC NULLS FIRST LIMIT 51'
    )


def test_sql_dataset_is_a_subquery_and_series_join() -> None:
    text = sql(
        {"metrics": ["count"], "series": "status", "time": {"grain": "month"}, "series_limit": 3},
        MY,
        "line",
        kind="sql",
    )
    assert (
        "FROM ( SELECT * FROM sales.`lines` ) AS `virtual_table` JOIN (" in text
    )  # `lines`: reserved
    assert (
        "GROUP BY `status` ORDER BY COUNT(*) DESC, `status` ASC LIMIT 3 ) AS `top_series`" in text
    )
    assert "ON `status` <=> `top_series`.`__series`" in text
    # Plain aliases in ORDER BY: no CASE ... IS NULL emulation on MySQL.
    assert text.endswith("ORDER BY `order_date` ASC, `status` ASC LIMIT 1001")
    assert "CASE" not in text


def test_series_limit_none_means_no_join() -> None:
    text = sql({"metrics": ["count"], "series": "status", "dimensions": [], "time": {"grain": "day"},
                "series_limit": None}, PG, "bar")  # fmt: skip
    assert "JOIN" not in text


def test_raw_records() -> None:
    text = sql(
        {"columns": ["order_date", "select"], "order_by": {"by": "order_date"}, "row_limit": 10}
    )
    assert text == (
        'SELECT "order_date", "select" FROM "sales"."Order Lines" '
        'ORDER BY "order_date" DESC NULLS LAST LIMIT 11'
    )


# ---------- filters ----------


@pytest.mark.parametrize(
    ("filter_", "postgres", "mysql"),
    [
        ({"column": "status", "operator": "=", "value": "paid"}, "\"status\" = 'paid'", "`status` = 'paid'"),
        ({"column": "status", "operator": "!=", "value": "paid"},
         "( \"status\" IS NULL OR \"status\" <> 'paid' )", "( `status` IS NULL OR `status` <> 'paid' )"),
        ({"column": "amount", "operator": ">=", "value": "2.5"}, '"amount" >= 2.5', "`amount` >= 2.5"),
        ({"column": "amount", "operator": "<", "value": 3}, '"amount" < 3', "`amount` < 3"),
        ({"column": "amount", "operator": "<=", "value": -1}, '"amount" <= -1', "`amount` <= -1"),
        ({"column": "status", "operator": "IN", "value": ["a", "b"]},
         "\"status\" IN ('a', 'b')", "`status` IN ('a', 'b')"),
        ({"column": "status", "operator": "NOT IN", "value": ["a"]},
         "( \"status\" IS NULL OR NOT \"status\" IN ('a') )", "( `status` IS NULL OR NOT `status` IN ('a') )"),
        ({"column": "order_date", "operator": "BETWEEN", "value": ["2025-01-01", "2025-01-31"]},
         "\"order_date\" BETWEEN CAST('2025-01-01' AS DATE) AND CAST('2025-01-31' AS DATE)",
         "`order_date` BETWEEN CAST('2025-01-01' AS DATE) AND CAST('2025-01-31' AS DATE)"),
        ({"column": "created at", "operator": ">", "value": "2025-01-01T10:30:00"},
         "\"created at\" > CAST('2025-01-01 10:30:00' AS TIMESTAMP)",
         "`created at` > CAST('2025-01-01 10:30:00' AS DATETIME)"),
        ({"column": "status", "operator": "IS NULL"}, '"status" IS NULL', "`status` IS NULL"),
        ({"column": "status", "operator": "IS NOT NULL"}, 'NOT "status" IS NULL', "NOT `status` IS NULL"),
        ({"column": "is_paid", "operator": "=", "value": True}, '"is_paid" = TRUE', "`is_paid` = TRUE"),
        ({"column": "status", "operator": "LIKE", "value": "Pa"},
         "\"status\" ILIKE '%Pa%'", "LOWER(`status`) LIKE LOWER('%Pa%')"),
    ],
)  # fmt: skip
def test_filter_operators(filter_: dict[str, Any], postgres: str, mysql: str) -> None:
    assert f"WHERE {postgres} GROUP BY" in sql({"metrics": ["count"], "dimensions": ["status"],
                                                "filters": [filter_]}, PG)  # fmt: skip
    assert f"WHERE {mysql} GROUP BY" in sql({"metrics": ["count"], "dimensions": ["status"],
                                             "filters": [filter_]}, MY)  # fmt: skip


@pytest.mark.parametrize(
    ("value", "postgres", "mysql"),
    [
        ("'; DROP TABLE x; --", "'''; DROP TABLE x; --'", "'''; DROP TABLE x; --'"),
        ('O\'Brien "quoted"', "'O''Brien \"quoted\"'", "'O''Brien \"quoted\"'"),
        ("back\\slash", "'back\\slash'", "'back\\\\slash'"),
    ],
)
def test_filter_values_are_literals(value: str, postgres: str, mysql: str) -> None:
    f = [{"column": "status", "operator": "=", "value": value}]
    assert f'WHERE "status" = {postgres} ORDER BY' in sql({"metrics": ["count"], "filters": f})
    assert f"WHERE `status` = {mysql} ORDER BY" in sql({"metrics": ["count"], "filters": f}, MY)
    # Also inside IN lists and LIKE patterns.
    in_list = [{"column": "status", "operator": "IN", "value": [value, "x"]}]
    assert f"\"status\" IN ({postgres}, 'x')" in sql({"metrics": ["count"], "filters": in_list})


def test_like_escapes_wildcards() -> None:
    f = [{"column": "status", "operator": "LIKE", "value": "50%_off\\"}]
    assert "ILIKE '%50\\%\\_off\\\\%'" in sql({"metrics": ["count"], "filters": f})
    assert "LIKE LOWER('%50\\\\%\\\\_off\\\\\\\\%')" in sql(
        {"metrics": ["count"], "filters": f}, MY
    )


def test_number_filter_value_must_be_a_number() -> None:
    message = error({"metrics": ["count"],
                     "filters": [{"column": "amount", "operator": "=", "value": "1; DROP TABLE x"}]})  # fmt: skip
    assert "is not a number" in message


# ---------- time ranges ----------


@pytest.mark.parametrize(
    ("kind", "start", "end"),
    [
        ("none", None, None),
        ("last_7_days", date(2026, 3, 8), date(2026, 3, 16)),
        ("last_30_days", date(2026, 2, 13), date(2026, 3, 16)),
        ("last_90_days", date(2025, 12, 15), date(2026, 3, 16)),
        ("last_12_months", date(2025, 3, 15), date(2026, 3, 16)),
        ("this_year", date(2026, 1, 1), date(2027, 1, 1)),
        ("last_year", date(2025, 1, 1), date(2026, 1, 1)),
    ],
)
def test_time_bounds(kind: str, start: date | None, end: date | None) -> None:
    assert time_bounds(TimeRange(kind=kind), TODAY) == (start, end)


def test_custom_and_clamped_time_bounds() -> None:
    custom = TimeRange(kind="custom", start=date(2025, 1, 1), end=date(2025, 1, 31))
    assert time_bounds(custom, TODAY) == (date(2025, 1, 1), date(2025, 2, 1))  # end inclusive
    assert time_bounds(TimeRange(kind="custom", end=date(2025, 1, 31)), TODAY) == (
        None,
        date(2025, 2, 1),
    )
    leap = time_bounds(TimeRange(kind="last_12_months"), date(2024, 2, 29))
    assert leap[0] == date(2023, 2, 28)


def test_time_range_in_sql() -> None:
    text = sql({"metrics": ["count"], "time": {"range": {"kind": "last_year"}}})
    assert (
        "WHERE \"order_date\" >= CAST('2025-01-01' AS DATE) "
        "AND \"order_date\" < CAST('2026-01-01' AS DATE)"
    ) in text


# ---------- validation ----------


@pytest.mark.parametrize(
    ("viz", "query", "message"),
    [
        ("table", {"metrics": ["nope"]}, 'Unknown metric "nope"'),
        ("table", {"metrics": ["count"], "dimensions": ["nope"]}, 'Unknown column "nope"'),
        ("table", {"metrics": ["count"], "dimensions": ["secret"]}, "is hidden"),
        ("table", {"metrics": ["count"], "dimensions": ["gone"]}, "no longer exists"),
        ("table", {"metrics": ["count"], "dimensions": ["note"]}, "Mark it as a dimension"),
        ("table", {"metrics": ["count"], "filters": [{"column": "secret", "operator": "IS NULL"}]}, "is hidden"),
        ("table", {"metrics": [{"column": "status", "aggregate": "SUM"}]}, "SUM doesn't work on \"status\""),
        ("table", {"metrics": [{"column": "is_paid", "aggregate": "MAX"}]}, "MAX doesn't work"),
        ("table", {"metrics": ["count"], "time": {"column": "status", "grain": "day"}}, "is not a time column"),
        ("table", {"metrics": ["count"], "order_by": {"by": "amount"}}, 'Can\'t order by "amount"'),
        ("table", {"metrics": ["count", {"column": "amount", "aggregate": "COUNT", "label": "count"}]},
         "appears twice"),
        ("table", {"metrics": ["count"], "dimensions": ["order_date"], "time": {"grain": "month"}},
         "already the time axis"),
        ("table", {}, "Pick at least one metric or dimension"),
        ("table", {"metrics": ["count"], "series": "status"}, "Only bar and line"),
        ("table", {"columns": ["status"], "metrics": ["count"]}, "Raw records can't have metrics"),
        ("table", {"columns": ["status"], "time": {"grain": "day"}}, "can't use a time grain"),
        ("big_number", {"metrics": ["count", "revenue"]}, "exactly one metric"),
        ("big_number", {"metrics": ["count"], "dimensions": ["status"]}, "can't have dimensions"),
        ("bar", {"metrics": ["count"]}, "Pick the bar chart's x axis"),
        ("bar", {"metrics": ["count"], "dimensions": ["status", "select"]}, "either one dimension"),
        ("bar", {"dimensions": ["status"]}, "at least one metric"),
        ("bar", {"metrics": ["count"], "dimensions": ["status"], "series": "status"}, "both a dimension and the series"),
        ("line", {"metrics": ["count"]}, "needs a time column and a time grain"),
        ("line", {"metrics": ["count"], "time": {"grain": "day"}, "dimensions": ["status"]}, "x axis is time"),
        ("table", {"metrics": ["count"], "filters": [{"column": "status", "operator": ">", "value": "a"}]},
         "The > operator doesn't work"),
        ("table", {"metrics": ["count"], "filters": [{"column": "amount", "operator": "LIKE", "value": "1"}]},
         "The LIKE operator doesn't work"),
        ("table", {"metrics": ["count"], "filters": [{"column": "is_paid", "operator": "<", "value": 1}]},
         "doesn't work"),
        ("table", {"metrics": ["count"], "filters": [{"column": "status", "operator": "IN", "value": []}]},
         "at least one value"),
        ("table", {"metrics": ["count"], "filters": [{"column": "status", "operator": "IN", "value": "a"}]},
         "needs a list"),
        ("table", {"metrics": ["count"], "filters": [{"column": "amount", "operator": "BETWEEN", "value": [1]}]},
         "needs two values"),
        ("table", {"metrics": ["count"], "filters": [{"column": "status", "operator": "IS NULL", "value": "x"}]},
         "takes no value"),
        ("table", {"metrics": ["count"], "filters": [{"column": "status", "operator": "=", "value": None}]},
         "needs a single value"),
        ("table", {"metrics": ["count"], "filters": [{"column": "order_date", "operator": "=", "value": "soon"}]},
         "is not a date"),
    ],
)  # fmt: skip
def test_validation_errors(viz: VizType, query: dict[str, Any], message: str) -> None:
    assert message in error(query, viz)


def test_no_main_time_column() -> None:
    ds = dataset()
    ds.main_time_column = None
    with pytest.raises(QueryError) as info:
        build_chart_query(
            ds, PG, "line", ChartQuery(dataset_id=1, metrics=["count"], time={"grain": "day"})
        )
    assert "no main time column" in info.value.message


# ---------- time range aligned to the grain ----------


@pytest.mark.parametrize(
    ("grain", "start"),
    [
        (None, "2026-02-13"),  # exact: today - 30 days
        ("day", "2026-02-13"),
        ("week", "2026-02-09"),  # the Monday of that week
        ("month", "2026-02-01"),
        ("quarter", "2026-01-01"),
        ("year", "2026-01-01"),
    ],
)
def test_range_start_snaps_to_the_grain(grain: str | None, start: str) -> None:
    time: dict[str, Any] = {"range": {"kind": "last_30_days"}}
    if grain:
        time["grain"] = grain
    text = sql({"metrics": ["count"], "time": time}, PG, "line" if grain else "table")
    assert (
        f"\"order_date\" >= CAST('{start}' AS DATE) AND \"order_date\" < CAST('2026-03-16' AS DATE)"
        in text
    )


def test_custom_range_snaps_too() -> None:
    time = {
        "grain": "month",
        "range": {"kind": "custom", "start": "2025-06-17", "end": "2025-08-03"},
    }
    text = sql({"metrics": ["count"], "time": time}, MY, "line")
    assert (
        "`order_date` >= CAST('2025-06-01' AS DATE) AND `order_date` < CAST('2025-08-04' AS DATE)"
        in text
    )


# ---------- NULLs with != / NOT IN / IN ----------


@pytest.mark.parametrize(
    ("filter_", "postgres", "mysql"),
    [
        ({"column": "status", "operator": "!=", "value": "a"},
         "( \"status\" IS NULL OR \"status\" <> 'a' )", "( `status` IS NULL OR `status` <> 'a' )"),
        ({"column": "status", "operator": "NOT IN", "value": ["a", "b"]},
         "( \"status\" IS NULL OR NOT \"status\" IN ('a', 'b') )",
         "( `status` IS NULL OR NOT `status` IN ('a', 'b') )"),
        ({"column": "status", "operator": "NOT IN", "value": ["a", None]},
         "NOT \"status\" IN ('a') AND NOT \"status\" IS NULL",
         "NOT `status` IN ('a') AND NOT `status` IS NULL"),
        ({"column": "status", "operator": "NOT IN", "value": [None]}, 'NOT "status" IS NULL', "NOT `status` IS NULL"),
        ({"column": "status", "operator": "IN", "value": ["a", None]},
         "( \"status\" IN ('a') OR \"status\" IS NULL )", "( `status` IN ('a') OR `status` IS NULL )"),
        ({"column": "status", "operator": "IN", "value": [None]}, '"status" IS NULL', "`status` IS NULL"),
        ({"column": "amount", "operator": "!=", "value": 3}, '( "amount" IS NULL OR "amount" <> 3 )',
         "( `amount` IS NULL OR `amount` <> 3 )"),
    ],
)  # fmt: skip
def test_null_handling(filter_: dict[str, Any], postgres: str, mysql: str) -> None:
    query = {"metrics": ["count"], "filters": [filter_]}
    assert f"WHERE {postgres} ORDER BY" in sql(query, PG)
    assert f"WHERE {mysql} ORDER BY" in sql(query, MY)


# ---------- Part 11: more chart types (SQL on both dialects) ----------

TIME_MONTH = {"column": "order_date", "grain": "month"}


@pytest.mark.parametrize("db", [PG, MY])
def test_area_is_a_line_with_series(db: str) -> None:
    line = sql({"metrics": ["revenue"], "series": "status", "time": TIME_MONTH}, db, "line")
    area = sql({"metrics": ["revenue"], "series": "status", "time": TIME_MONTH}, db, "area")
    assert area == line
    assert "top_series" in area


@pytest.mark.parametrize("db", [PG, MY])
def test_combo_metrics_on_a_time_or_dimension_axis(db: str) -> None:
    q = '"' if db == PG else "`"
    by_time = sql({"metrics": ["revenue", "count"], "time": TIME_MONTH}, db, "combo")
    assert f"SUM(amount) AS {q}revenue{q}" in by_time and f"COUNT(*) AS {q}count{q}" in by_time
    assert f"ORDER BY {q}order_date{q} ASC" in by_time
    by_dim = sql({"metrics": ["revenue", "count"], "dimensions": ["status"]}, db, "combo")
    assert f"GROUP BY {q}status{q}" in by_dim


@pytest.mark.parametrize("db", [PG, MY])
def test_funnel_steps_by_value(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["count"], "dimensions": ["status"], "row_limit": 50}, db, "funnel")
    assert f"SELECT {q}status{q}, COUNT(*) AS {q}count{q}" in text
    assert f"GROUP BY {q}status{q} ORDER BY {q}count{q} DESC" in text
    assert text.endswith("LIMIT 51")


@pytest.mark.parametrize("db", [PG, MY])
def test_gauge_is_one_total_with_a_rows_probe(db: str) -> None:
    rng = {"column": "order_date", "range": {"kind": "last_30_days"}}
    built = build_chart_query(dataset(), db, "gauge",
                              ChartQuery(dataset_id=1, metrics=["revenue"], time=rng), today=TODAY)  # fmt: skip
    assert built.rows_probe
    assert "GROUP BY" not in built.sql
    assert "__first_time" in built.sql


@pytest.mark.parametrize("db", [PG, MY])
def test_treemap_two_levels_top_n_and_other(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["revenue"], "dimensions": ["status", "is_paid"], "series_limit": 5},
               db, "treemap")  # fmt: skip
    # Both levels are blanked outside the top N outer values: one "Other" box.
    assert (
        f"CASE WHEN {q}top_series{q}.{q}__is_top{q} = 1 THEN {q}status{q} END AS {q}status{q}"
        in text
    )
    assert (
        f"CASE WHEN {q}top_series{q}.{q}__is_top{q} = 1 THEN {q}is_paid{q} END AS {q}is_paid{q}"
        in text
    )
    assert (
        f"GROUP BY {q}status{q} ORDER BY SUM(amount) DESC" in text
    )  # the top N, by the outer level
    assert "LIMIT 5" in text
    # One level without a limit: a plain GROUP BY, like a pie.
    plain = sql(
        {"metrics": ["revenue"], "dimensions": ["status"], "series_limit": None}, db, "treemap"
    )
    assert "top_series" not in plain and f"GROUP BY {q}status{q}" in plain


def test_pivot_on_postgres_is_one_scan_with_grouping_sets() -> None:
    text = sql({"metrics": ["revenue"], "dimensions": ["status", "select"],
                "column_dimensions": ["is_paid"], "totals": True}, PG, "pivot_table")  # fmt: skip
    assert text.count("FROM") == 1
    assert (
        'GROUPING SETS ( (), ("is_paid"), ("status"), ("status", "is_paid"), ("status", "select"), '
        '("status", "select", "is_paid") )' in text
    )
    assert '( 1 - GROUPING("status") + 1 - GROUPING("select") ) AS "__row_level"' in text
    assert '( 1 - GROUPING("is_paid") ) AS "__col_level"' in text


def test_pivot_on_mysql_is_a_union_all_per_level() -> None:
    text = sql({"metrics": ["revenue"], "dimensions": ["status", "select"],
                "column_dimensions": ["is_paid"], "totals": True}, MY, "pivot_table")  # fmt: skip
    assert "GROUPING" not in text
    assert text.count("UNION ALL") == 5  # (2 + 1) row levels x (1 + 1) column levels
    assert (
        "NULL AS `status`, NULL AS `select`, NULL AS `is_paid`, 0 AS `__row_level`, 0 AS `__col_level`"
        in text
    )
    assert (
        "`status` AS `status`, NULL AS `select`, `is_paid` AS `is_paid`, 1 AS `__row_level`, 1 AS `__col_level`"
        in text
    )
    assert text.endswith("LIMIT 1001")


@pytest.mark.parametrize("db", [PG, MY])
def test_pivot_without_totals_is_one_group_by(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["count"], "dimensions": ["status"], "column_dimensions": ["is_paid"]},
               db, "pivot_table")  # fmt: skip
    assert "GROUPING" not in text and "UNION" not in text
    assert f"1 AS {q}__row_level{q}, 1 AS {q}__col_level{q}" in text
    assert f"GROUP BY {q}status{q}, {q}is_paid{q}" in text


@pytest.mark.parametrize(
    ("viz", "query", "message"),
    [
        ("area", {"metrics": ["count"]}, "needs a time column and a time grain"),
        ("area", {"metrics": ["count"], "dimensions": ["status"], "time": TIME_MONTH}, "x axis is time"),
        ("combo", {"metrics": ["count"]}, "Pick the combo chart's x axis"),
        ("combo", {"metrics": ["count"], "dimensions": ["status"], "series": "is_paid"},
         "Only bar and line charts (and area charts) have a series"),
        ("funnel", {"metrics": ["count"], "dimensions": ["status", "is_paid"]}, "exactly one dimension (the steps)"),
        ("funnel", {"metrics": ["count", "revenue"], "dimensions": ["status"]}, "A funnel shows exactly one metric"),
        ("gauge", {"metrics": ["count"], "dimensions": ["status"]}, "A gauge can't have dimensions"),
        ("gauge", {"metrics": ["count"], "time": TIME_MONTH}, "A gauge has no time grain"),
        ("treemap", {"metrics": ["count"], "dimensions": []}, "one or two dimensions"),
        ("treemap", {"metrics": ["count"], "dimensions": ["status", "select", "is_paid"]}, "one or two dimensions"),
        ("treemap", {"metrics": ["count"], "dimensions": ["status", "status"]}, "two different dimensions"),
        ("pivot_table", {"metrics": ["count"]}, "at least one row or column dimension"),
        ("pivot_table", {"metrics": ["count"], "dimensions": ["status", "select", "is_paid", "order_date"]},
         "at most 3 row dimensions"),
        ("pivot_table", {"metrics": ["count"], "column_dimensions": ["status", "select", "is_paid"]},
         "at most 2 column dimensions"),
        ("pivot_table", {"metrics": ["count"], "dimensions": ["status"], "column_dimensions": ["status"]},
         "both a row and a column dimension"),
        ("pivot_table", {"metrics": ["count"], "dimensions": ["status"], "time": TIME_MONTH}, "no time grain"),
        ("bar", {"metrics": ["count"], "dimensions": ["status"], "column_dimensions": ["is_paid"]},
         "Only pivot tables have column dimensions"),
    ],
)  # fmt: skip
def test_part11_validation(viz: VizType, query: dict[str, Any], message: str) -> None:
    assert message in error(query, viz)


# ---------- Part 11 round 2: time parts, date buckets, heatmap, scatter, histogram, map ----------


@pytest.mark.parametrize(
    ("part", "postgres", "mysql"),
    [
        ("day_of_week", 'CAST(EXTRACT(ISODOW FROM "created at") AS INT)', "( WEEKDAY(`created at`) + 1 )"),
        ("hour_of_day", 'CAST(EXTRACT(HOUR FROM "created at") AS INT)', "HOUR(`created at`)"),
        ("month_of_year", 'CAST(EXTRACT(MONTH FROM "created at") AS INT)', "MONTH(`created at`)"),
    ],
)  # fmt: skip
def test_time_parts(part: str, postgres: str, mysql: str) -> None:
    """Integers on both databases; day_of_week is 1 = Monday ... 7 = Sunday on both."""
    query = {"metrics": ["count"], "dimensions": [f"created at@{part}"]}
    assert f'{postgres} AS "created at@{part}"' in sql(query, PG)
    assert f"{mysql} AS `created at@{part}`" in sql(query, MY)
    assert f"GROUP BY {postgres}" in sql(query, PG)


@pytest.mark.parametrize("db", [PG, MY])
def test_date_buckets_as_dimensions(db: str) -> None:
    text = sql({"metrics": ["count"], "dimensions": ["order_date@quarter"]}, db)
    bucket = (
        "CAST(DATE_TRUNC('quarter', \"order_date\") AS DATE)"
        if db == PG
        else "MAKEDATE(YEAR(`order_date`), 1) + INTERVAL ( QUARTER(`order_date`) - 1 ) QUARTER"
    )
    assert bucket in text


@pytest.mark.parametrize(
    ("dimension", "message"),
    [
        ("status@month", '"status" is not a time column'),
        ("order_date@hour_of_day", "is a date without a time, so it has no hour"),
        ("order_date@fortnight", 'Unknown time part "fortnight"'),
        ("nope@month", 'Unknown column "nope"'),
    ],
)
def test_time_part_errors(dimension: str, message: str) -> None:
    assert message in error({"metrics": ["count"], "dimensions": [dimension]})


@pytest.mark.parametrize("db", [PG, MY])
def test_pivot_with_date_buckets_on_both_sides(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["count"], "dimensions": ["order_date@year"],
                "column_dimensions": ["created at@month"], "totals": True}, db, "pivot_table")  # fmt: skip
    assert f"AS {q}order_date@year{q}" in text
    assert f"AS {q}created at@month{q}" in text
    if db == PG:
        assert "GROUPING(CAST(DATE_TRUNC('year', \"order_date\") AS DATE))" in text
    else:
        assert text.count("UNION ALL") == 3


@pytest.mark.parametrize("db", [PG, MY])
def test_heatmap_orders_by_its_two_dimensions(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["count"], "dimensions": ["created at@day_of_week", "created at@hour_of_day"]},
               db, "heatmap")  # fmt: skip
    nulls = " NULLS FIRST" if db == PG else ""
    assert text.endswith(
        f"ORDER BY {q}created at@day_of_week{q} ASC{nulls}, {q}created at@hour_of_day{q} ASC{nulls} LIMIT 1001"
    )


@pytest.mark.parametrize("db", [PG, MY])
def test_scatter_keeps_every_point_of_every_color(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["revenue", "count"], "dimensions": ["status"], "series": "select",
                "series_limit": 3, "row_limit": 5000}, db, "scatter")  # fmt: skip
    assert "top_series" not in text  # no top-N join: points would disappear
    assert f"GROUP BY {q}status{q}, {q}select{q}" in text
    assert text.endswith("LIMIT 5001")


@pytest.mark.parametrize("db", [PG, MY])
def test_histogram_by_number_of_bins(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["count"], "bins": {"column": "amount", "count": 10}}, db, "histogram")
    # NULL values: their own bin; one value only: bin 0; MAX goes in the last bin.
    assert f"WHEN {q}amount{q} IS NULL THEN NULL" in text
    assert f"WHEN {q}__bounds{q}.{q}__hi{q} = {q}__bounds{q}.{q}__lo{q} THEN 0" in text
    assert "* 10 ), 9 )" in text
    assert (
        f"CROSS JOIN ( SELECT MIN({q}amount{q}) AS {q}__lo{q}, MAX({q}amount{q}) AS {q}__hi{q}"
        in text
    )
    float_type = "DOUBLE PRECISION" if db == PG else "DOUBLE"
    assert f"CAST({q}amount{q} AS {float_type})" in text


@pytest.mark.parametrize("db", [PG, MY])
def test_histogram_by_width_is_aligned_to_multiples(db: str) -> None:
    q = '"' if db == PG else "`"
    text = sql({"metrics": ["count"], "bins": {"column": "amount", "width": 2.5}}, db, "histogram")
    assert "__bounds" not in text
    assert f"{q}__binned{q}.{q}__bin{q} * 2.5 AS {q}__bin_start{q}" in text
    assert f"( {q}__binned{q}.{q}__bin{q} + 1 ) * 2.5 AS {q}__bin_end{q}" in text


def test_histogram_respects_filters_in_both_scans() -> None:
    text = sql({"metrics": ["count"], "bins": {"column": "amount"},
                "filters": [{"column": "status", "operator": "=", "value": "paid"}]}, PG, "histogram")  # fmt: skip
    assert text.count("WHERE \"status\" = 'paid'") == 2  # the bounds and the bins


@pytest.mark.parametrize(
    ("viz", "query", "message"),
    [
        ("heatmap", {"metrics": ["count"], "dimensions": ["status"]}, "two dimensions"),
        ("heatmap", {"metrics": ["count"], "dimensions": ["status", "status"]}, "two different dimensions"),
        ("heatmap", {"metrics": ["count"], "dimensions": ["status", "select"],
                     "time": {"column": "order_date", "grain": "month"}}, "use a date bucket"),
        ("scatter", {"metrics": ["count"], "dimensions": ["status"]}, "an x and a y metric"),
        ("scatter", {"metrics": ["count", "revenue"], "dimensions": []}, "one point per value"),
        ("histogram", {"metrics": ["count"]}, "a number column to bin"),
        ("histogram", {"metrics": ["count"], "bins": {"column": "status"}}, "isn't a number column"),
        ("histogram", {"metrics": ["count"], "bins": {"column": "amount"}, "dimensions": ["status"]},
         "no dimensions"),
        ("bar", {"metrics": ["count"], "dimensions": ["status"], "bins": {"column": "amount"}},
         "Only histograms have bins"),
        ("world_map", {"metrics": ["count"], "dimensions": []}, "the countries"),
        ("world_map", {"metrics": ["count", "revenue"], "dimensions": ["status"]}, "exactly one metric"),
    ],
)  # fmt: skip
def test_round2_validation(viz: VizType, query: dict[str, Any], message: str) -> None:
    assert message in error(query, viz)


def test_bin_spec_limits() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ChartQuery(dataset_id=1, bins={"column": "amount", "count": 0})
    with pytest.raises(ValidationError):
        ChartQuery(dataset_id=1, bins={"column": "amount", "count": 201})
    with pytest.raises(ValidationError):
        ChartQuery(dataset_id=1, bins={"column": "amount", "width": 0})
