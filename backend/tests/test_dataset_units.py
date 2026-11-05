"""Dataset logic that doesn't need a database: SQL generation, quoting, checks, merging."""

import pytest

from app.datasets import (
    DatasetSource,
    DetectedColumn,
    check_dataset_sql,
    column,
    merge_columns,
    metric_warning,
    parse_metric_expression,
    select_sql,
    sqllab_sql,
)
from app.datasets.sql import from_clause
from app.models import Dataset, DatasetColumn
from app.query import QueryError

PG, MY = "postgresql", "mysql"


def table(schema: str, name: str) -> DatasetSource:
    return DatasetSource("table", schema=schema, table_name=name)


def sql(text: str) -> DatasetSource:
    return DatasetSource("sql", sql=text)


# ---------- FROM clause and quoting ----------


@pytest.mark.parametrize(
    ("schema", "name", "postgres", "mysql"),
    [
        ("sales", "orders", '"sales"."orders"', "`sales`.`orders`"),
        ("My Schema", "Order Items", '"My Schema"."Order Items"', "`My Schema`.`Order Items`"),
        ("Sales", "CamelCase", '"Sales"."CamelCase"', "`Sales`.`CamelCase`"),
        ("public", "select", '"public"."select"', "`public`.`select`"),
        ("order", "group", '"order"."group"', "`order`.`group`"),
        # Quote characters inside names are doubled, never break out of the identifier.
        ("s", 'say "hi"', '"s"."say ""hi"""', '`s`.`say "hi"`'),
        ("s", "back`tick", '"s"."back`tick"', "`s`.`back``tick`"),
    ],
)
def test_table_from_clause_quotes_identifiers(
    schema: str, name: str, postgres: str, mysql: str
) -> None:
    assert select_sql(table(schema, name), PG) == f"SELECT * FROM {postgres}"
    assert select_sql(table(schema, name), MY) == f"SELECT * FROM {mysql}"
    assert from_clause(table(schema, name), PG).sql(dialect="postgres") == postgres


def test_sql_dataset_becomes_aliased_subquery() -> None:
    source = sql("SELECT id, status FROM sales.orders;")
    assert select_sql(source, PG, limit=0) == (
        'SELECT * FROM (SELECT id, status FROM sales.orders) AS "virtual_table" LIMIT 0'
    )
    assert select_sql(source, MY, limit=0) == (
        "SELECT * FROM (SELECT id, status FROM sales.orders) AS `virtual_table` LIMIT 0"
    )


def test_sql_dataset_keeps_the_users_quoting() -> None:
    # Unquoted Orders means orders on Postgres; forcing quotes would change that.
    source = sql('SELECT o.Id, c."Full Name" FROM Orders o JOIN "Customers" c ON c.id = o.cid')
    rendered = select_sql(source, PG)
    assert "FROM Orders AS o" in rendered
    assert 'c."Full Name"' in rendered
    assert 'JOIN "Customers" AS c' in rendered


def test_projections_use_quoted_columns() -> None:
    expr = parse_metric_expression("SUM(amount)", PG)
    rendered = select_sql(
        table("sales", "orders"), PG, [column("Order Date"), expr.as_("value", quoted=True)], 1
    )
    assert rendered == 'SELECT "Order Date", SUM(amount) AS "value" FROM "sales"."orders" LIMIT 1'
    rendered = select_sql(table("sales", "orders"), MY, [column("select")], 1)
    assert rendered == "SELECT `select` FROM `sales`.`orders` LIMIT 1"


def test_sqllab_sql() -> None:
    assert sqllab_sql(table("sales", "Order Items"), PG) == 'SELECT * FROM "sales"."Order Items"'
    assert sqllab_sql(sql("SELECT 1 AS x"), PG) == "SELECT 1 AS x"


# ---------- SQL dataset checks ----------


@pytest.mark.parametrize("db_type", [PG, MY])
@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("DELETE FROM sales.orders", "read_only"),
        ("SELECT 1; SELECT 2", "multiple_statements"),
        ("SELECT 1; DROP TABLE sales.orders", "multiple_statements"),
        ("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "read_only"),
        ("SELECT * INTO new_table FROM t", "read_only"),
        ("SHOW TABLES", "not_allowed"),
        ("", "invalid"),
    ],
)
def test_unsafe_dataset_sql_is_rejected(db_type: str, text: str, kind: str) -> None:
    if db_type == MY and "RETURNING" in text:
        pytest.skip("Postgres syntax")
    with pytest.raises(QueryError) as info:
        check_dataset_sql(text, db_type)
    assert info.value.kind == kind


def test_dataset_sql_warnings() -> None:
    assert check_dataset_sql("SELECT * FROM t", PG) == []
    assert check_dataset_sql("SELECT * FROM t WHERE x IN (SELECT y FROM u LIMIT 3)", PG) == []
    order = check_dataset_sql("SELECT * FROM t ORDER BY 1;", PG)
    assert len(order) == 1 and "ORDER BY" in order[0]
    both = check_dataset_sql("SELECT a FROM t UNION SELECT b FROM u ORDER BY 1 LIMIT 5", MY)
    assert len(both) == 2 and "LIMIT" in both[1]


# ---------- metric expressions ----------


@pytest.mark.parametrize(
    "text",
    [
        "COUNT(*)",
        "SUM(amount)",
        "COUNT(DISTINCT customer_id)",
        "SUM(quantity * unit_price) / NULLIF(COUNT(*), 0)",
        "SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END)",
        'SUM("Total Amount")',
    ],
)
def test_valid_metric_expressions(text: str) -> None:
    parsed = parse_metric_expression(text, PG)
    assert metric_warning(parsed) is None


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("", "invalid"),
        ("SUM(x); DROP TABLE t", "multiple_statements"),
        ("1; DELETE FROM t", "multiple_statements"),
        ("SUM(x) FROM t", "invalid"),
        ("SUM(x) WHERE 1 = 1", "invalid"),
        ("SUM(x), COUNT(*)", "invalid"),
        ("SUM(x) AS total", "invalid"),
        ("*", "invalid"),
        ("SUM(x", "syntax"),
        ("(SELECT 1 INTO t2)", "read_only"),
    ],
)
def test_invalid_metric_expressions(text: str, kind: str) -> None:
    with pytest.raises(QueryError) as info:
        parse_metric_expression(text, PG)
    assert info.value.kind == kind


def test_non_aggregate_metric_gets_a_warning() -> None:
    assert metric_warning(parse_metric_expression("amount * 2", PG)) is not None


# ---------- merging synced columns ----------


def detected(*specs: tuple[str, str]) -> list[DetectedColumn]:
    return [DetectedColumn(name, generic, generic) for name, generic in specs]


def test_merge_guesses_settings_for_new_columns() -> None:
    dataset = Dataset(columns=[])
    result = merge_columns(
        dataset,
        detected(("id", "number"), ("status", "string"), ("created", "datetime")),
    )
    assert result.added == ["id", "status", "created"]
    by_name = {c.name: c for c in dataset.columns}
    assert by_name["created"].is_temporal and not by_name["created"].is_dimension
    assert by_name["status"].is_dimension and not by_name["status"].is_temporal
    assert not by_name["id"].is_dimension
    assert dataset.main_time_column == "created"  # the only temporal column


def test_merge_does_not_guess_between_two_time_columns() -> None:
    dataset = Dataset(columns=[])
    merge_columns(dataset, detected(("a", "date"), ("b", "datetime")))
    assert dataset.main_time_column is None


def test_merge_keeps_settings_and_marks_missing_columns() -> None:
    status = DatasetColumn(
        name="status", label="Order status", generic_type="string",
        generic_type_override="other", is_temporal=False, is_dimension=False,
        is_hidden=True, is_missing=False, description="kept", position=1,
    )  # fmt: skip
    day = DatasetColumn(
        name="day", generic_type="date", is_temporal=True, is_dimension=False,
        is_hidden=False, is_missing=False, position=0,
    )  # fmt: skip
    dataset = Dataset(columns=[day, status], main_time_column="day")

    result = merge_columns(dataset, detected(("status", "string"), ("amount", "number")))
    assert result.added == ["amount"]
    assert result.removed == ["day"]
    assert day.is_missing and dataset.main_time_column is None
    assert (status.label, status.generic_type_override, status.is_hidden, status.description) == (
        "Order status", "other", True, "kept",
    )  # fmt: skip
    assert [c.name for c in dataset.columns] == ["status", "amount", "day"]

    # The column comes back: same row, settings intact.
    result = merge_columns(dataset, detected(("day", "date"), ("status", "string")))
    assert result.restored == ["day"] and not day.is_missing
    assert dataset.main_time_column == "day"
    assert result.removed == ["amount"]
