"""Part 13: numbers and text used as time (year numbers, text dates), the lazy check of old
time columns, line / area x axes, detection rules and friendly query errors.

Integration tests run against the real sampledb (Postgres); MySQL SQL is checked in
tests/test_charts_mysql.py (and rendered here)."""

import os
from collections.abc import Callable, Iterator
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, select, text
from sqlalchemy.engine import URL
from sqlalchemy.orm import Session, sessionmaker

import app.api.datasets as datasets_api
from app.charts import build_chart_query
from app.datasets.sql import column
from app.datasets.timecols import (
    is_code_name,
    is_identifier_name,
    is_year_name,
    name_tokens,
    time_expression,
)
from app.models import Dataset, DatasetColumn, DatasetMetric
from app.query import QueryError
from app.query.errors import explain
from app.schemas.charts import ChartQuery
from app.uploads.types import NumberFormat, guess_column

# One row per order: a BIGINT year, a real date, day-first dates as text with mixed
# separators (and a few that aren't dates), and a number that isn't a year.
ORDERS_SQL = """
SELECT o.id AS order_id,
       EXTRACT(YEAR FROM o.order_date)::bigint AS "Year",
       o.order_date,
       CASE WHEN o.id % 25 = 0 THEN 'unknown'
            WHEN o.id % 2 = 0 THEN to_char(o.order_date, 'FMDD/FMMM/YYYY')
            ELSE to_char(o.order_date, 'DD-MM-YYYY') END AS order_day_text,
       o.id * 1.5 AS not_years,
       o.status
FROM sales.orders o
"""


@pytest.fixture(scope="module")
def sampledb() -> Iterator[Engine]:
    url = URL.create(
        "postgresql+psycopg",
        username=os.environ["SAMPLEDB_USER"],
        password=os.environ["SAMPLEDB_PASSWORD"],
        host="sampledb",
        port=5432,
        database=os.environ["SAMPLEDB_DB"],
    )
    engine = create_engine(url)
    yield engine
    engine.dispose()


def expected(sampledb: Engine, sql: str) -> list[list[Any]]:
    with sampledb.connect() as conn:
        rows = conn.execute(text(f"WITH o AS ({ORDERS_SQL}) {sql}")).all()
    return [[v.isoformat() if isinstance(v, date) else v for v in row] for row in rows]


@pytest.fixture
def connection_id(client: TestClient, sampledb_payload: Callable[..., dict[str, Any]]) -> int:
    response = client.post("/api/connections", json=sampledb_payload())
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


@pytest.fixture
def orders(client: TestClient, connection_id: int) -> dict[str, Any]:
    response = client.post(
        "/api/datasets",
        json={"name": "Orders by year", "connection_id": connection_id, "kind": "sql",
              "sql": ORDERS_SQL},
    )  # fmt: skip
    assert response.status_code == 201, response.text
    data: dict[str, Any] = response.json()
    return data


def col_of(dataset: dict[str, Any], name: str) -> dict[str, Any]:
    found: dict[str, Any] = next(c for c in dataset["columns"] if c["name"] == name)
    return found


def chart(client: TestClient, viz: str, dataset_id: int, **query: Any) -> Any:
    return client.post(
        "/api/chart-data", json={"viz_type": viz, "query": {"dataset_id": dataset_id, **query}}
    )


def update_columns(
    client: TestClient, dataset: dict[str, Any], changes: dict[str, dict[str, Any]]
) -> Any:
    columns = []
    for c in dataset["columns"]:
        settings = {
            "id": c["id"], "label": c["label"], "generic_type_override": c["generic_type_override"],
            "is_temporal": c["is_temporal"], "is_dimension": c["is_dimension"],
            "is_hidden": c["is_hidden"], "description": c["description"],
        }  # fmt: skip
        settings.update(changes.get(c["name"], {}))
        columns.append(settings)
    return client.put(
        f"/api/datasets/{dataset['id']}",
        json={"name": dataset["name"], "main_time_column": dataset["main_time_column"],
              "columns": columns},
    )  # fmt: skip


# ---------- detection ----------


def test_a_new_dataset_detects_year_and_identifier_columns(orders: dict[str, Any]) -> None:
    year = col_of(orders, "Year")
    assert year["is_temporal"] and year["time_kind"] == "year_number"
    assert not year["is_identifier"]
    assert col_of(orders, "order_id")["is_identifier"]
    assert col_of(orders, "order_date")["time_kind"] is None
    # A real date column wins as the main time column.
    assert orders["main_time_column"] == "order_date"
    # Not years (fractions), so not suggested; text isn't detected on its own.
    assert not col_of(orders, "not_years")["looks_like_years"]
    assert not col_of(orders, "order_day_text")["is_temporal"]


def test_values_alone_only_suggest_years(client: TestClient, connection_id: int) -> None:
    response = client.post(
        "/api/datasets",
        json={"name": "Seasons", "connection_id": connection_id, "kind": "sql",
              "sql": "SELECT EXTRACT(YEAR FROM order_date)::int AS season, id FROM sales.orders"},
    )  # fmt: skip
    assert response.status_code == 201, response.text
    season = col_of(response.json(), "season")
    assert season["looks_like_years"] and not season["is_temporal"]
    assert response.json()["main_time_column"] is None


@pytest.mark.parametrize(
    ("name", "year", "identifier", "code"),
    [
        ("Year", True, False, False),
        ("Year_of_Release", True, False, False),
        ("année", True, False, False),
        ("fiscalYr", True, False, False),
        ("yearly_total", False, False, False),
        ("row_id", False, True, False),  # id-named: text only if the values are
        ("Row ID", False, True, False),
        ("customerID", False, True, False),
        ("product_code", False, True, True),
        ("Postal Code", False, True, True),
        ("zip", False, True, True),
        ("Phone", False, True, True),
        ("Rank", False, True, False),  # a number, but nothing to sum
        ("paid", False, False, False),
        ("valid_until", False, False, False),
        ("Global_Sales", False, False, False),
    ],
)
def test_name_rules(name: str, year: bool, identifier: bool, code: bool) -> None:
    assert is_year_name(name) is year
    assert is_identifier_name(name) is identifier
    assert is_code_name(name) is code


def test_name_tokens() -> None:
    assert name_tokens("orderDate") == ["order", "date"]
    assert name_tokens("Année de vente") == ["annee", "de", "vente"]


FMT = NumberFormat(".", "")


def test_upload_guess_keeps_codes_as_text() -> None:
    assert guess_column(["42420", "90036", "10024"], FMT, code_like=True).type == "text"
    assert guess_column(["02134", "90036", "10024"], FMT).type == "text"  # leading zero
    assert guess_column(["0", "12", "7"], FMT).type == "integer"  # a lone 0 is a number
    assert guess_column(["1.5", "2"], FMT, code_like=True).type == "text"
    assert guess_column(["10", "20"], FMT).type == "integer"
    # Id-named columns follow their values: plain numbers stay numbers; codes or leading
    # zeros are text.
    assert guess_column(["1", "2", "10"], FMT, code_like=is_code_name("Row ID")).type == "integer"
    assert guess_column(["CA-2013-152156", "US-2012-108966"], FMT).type == "text"
    assert (
        guess_column(["007", "012", "100"], FMT, code_like=is_code_name("agent_id")).type == "text"
    )


def test_upload_guess_years_and_null_words() -> None:
    guess = guess_column(["2006", "1985", "N/A", "2010", "n/a"], FMT, year_like=True)
    assert (guess.type, guess.years, guess.null_words) == ("integer", "name", 2)
    assert guess_column(["2006", "1985"], FMT).years == "values"
    assert guess_column(["2006", "1850"], FMT, year_like=True).years is None
    assert guess_column(["2006.5", "1985"], FMT, year_like=True).years is None


# ---------- year numbers in charts ----------


def test_yearly_line_chart_on_a_year_number(
    client: TestClient, orders: dict[str, Any], sampledb: Engine
) -> None:
    response = chart(client, "line", orders["id"], metrics=["count"],
                     time={"column": "Year", "grain": "year"})  # fmt: skip
    assert response.status_code == 200, response.text
    assert response.json()["rows"] == expected(
        sampledb, 'SELECT make_date("Year"::int, 1, 1), COUNT(*) FROM o GROUP BY 1 ORDER BY 1'
    )


def test_finer_grains_are_refused_for_year_numbers(
    client: TestClient, orders: dict[str, Any]
) -> None:
    for grain in ("month", "day"):
        response = chart(client, "line", orders["id"], metrics=["count"],
                         time={"column": "Year", "grain": grain})  # fmt: skip
        assert response.status_code == 400
        assert "only has years" in response.json()["detail"]["message"]
    response = chart(client, "heatmap", orders["id"], metrics=["count"],
                     dimensions=["Year@month_of_year", "status"])  # fmt: skip
    assert response.status_code == 400
    assert "only has years" in response.json()["detail"]["message"]


def test_year_numbers_with_time_ranges_and_the_no_data_hint(
    client: TestClient, orders: dict[str, Any], sampledb: Engine
) -> None:
    [[first, last]] = expected(sampledb, 'SELECT MIN("Year"), MAX("Year") FROM o')
    inside = chart(client, "big_number", orders["id"], metrics=["count"],
                   time={"column": "Year", "range": {"kind": "custom",
                         "start": f"{last}-01-01", "end": f"{last}-12-31"}})  # fmt: skip
    assert inside.status_code == 200, inside.text
    assert inside.json()["rows"] == expected(
        sampledb, f'SELECT COUNT(*) FROM o WHERE "Year" = {last}'
    )
    # No row in the range: no rows at all (the big number shows "-" and the hint).
    empty = chart(client, "big_number", orders["id"], metrics=["count"],
                  time={"column": "Year", "range": {"kind": "custom",
                        "start": "1990-01-01", "end": "1990-12-31"}})  # fmt: skip
    assert empty.status_code == 200 and empty.json()["rows"] == []
    extent = client.get(f"/api/datasets/{orders['id']}/time-extent", params={"column": "Year"})
    assert extent.json() == {"column": "Year", "min": f"{first}-01-01", "max": f"{last}-01-01"}


def test_raw_values_grain(client: TestClient, orders: dict[str, Any], sampledb: Engine) -> None:
    response = chart(client, "line", orders["id"], metrics=["count"],
                     time={"column": "order_date", "grain": "raw"}, row_limit=5000)  # fmt: skip
    assert response.status_code == 200, response.text
    assert response.json()["rows"] == expected(
        sampledb, "SELECT order_date, COUNT(*) FROM o GROUP BY 1 ORDER BY 1"
    )


def test_line_and_area_charts_take_a_dimension_on_the_x_axis(
    client: TestClient, orders: dict[str, Any], sampledb: Engine
) -> None:
    for viz in ("line", "area"):
        response = chart(client, viz, orders["id"], metrics=["count"], dimensions=["status"])
        assert response.status_code == 200, response.text
        # Ordered by the category (ascending), not by the metric.
        assert response.json()["rows"] == expected(
            sampledb, "SELECT status, COUNT(*) FROM o GROUP BY 1 ORDER BY 1 NULLS FIRST"
        )


# ---------- marking columns as time ----------


def test_marking_a_number_column_as_time(client: TestClient, orders: dict[str, Any]) -> None:
    refused = update_columns(client, orders, {"not_years": {"is_temporal": True}})
    assert refused.status_code == 400
    assert "aren't years" in refused.json()["detail"]
    # Unmark and mark the year column again: it is checked and stays a year number.
    off = update_columns(client, orders, {"Year": {"is_temporal": False}})
    assert off.status_code == 200, off.text
    assert col_of(off.json(), "Year")["time_kind"] is None
    on = update_columns(client, off.json(), {"Year": {"is_temporal": True}})
    assert on.status_code == 200, on.text
    assert col_of(on.json(), "Year")["time_kind"] == "year_number"


def test_only_dates_years_and_text_dates_can_be_time(
    client: TestClient, connection_id: int
) -> None:
    response = client.post(
        "/api/datasets",
        json={"name": "Flags", "connection_id": connection_id, "kind": "sql",
              "sql": "SELECT id, status = 'paid' AS is_paid FROM sales.orders"},
    )  # fmt: skip
    dataset = response.json()
    refused = update_columns(client, dataset, {"is_paid": {"is_temporal": True}})
    assert refused.status_code == 400
    assert "can't be a time column" in refused.json()["detail"]


def test_text_dates_become_a_time_column(
    client: TestClient, orders: dict[str, Any], sampledb: Engine
) -> None:
    response = update_columns(client, orders, {"order_day_text": {"is_temporal": True}})
    assert response.status_code == 200, response.text
    dataset = response.json()
    text_col = col_of(dataset, "order_day_text")
    # Day first (days above 12 decide it), "/" and "-" mixed.
    assert (text_col["time_kind"], text_col["text_date_format"]) == ("text_date", "dmy")
    [[unknown, total_rows]] = expected(
        sampledb, "SELECT COUNT(*) FILTER (WHERE order_day_text = 'unknown'), COUNT(*) FROM o"
    )
    [note] = dataset["notes"]
    assert f"{unknown:,} of {total_rows:,} values aren't dates in DD-MM-YYYY" in note["message"]

    monthly = chart(client, "bar", orders["id"], metrics=["count"],
                    time={"column": "order_day_text", "grain": "month"})  # fmt: skip
    assert monthly.status_code == 200, monthly.text
    # Values that aren't dates are an empty bucket, like NULL dates.
    assert monthly.json()["rows"] == expected(
        sampledb,
        "SELECT CASE WHEN order_day_text <> 'unknown' THEN date_trunc('month', order_date)::date "
        "END AS m, COUNT(*) FROM o GROUP BY 1 ORDER BY 1 NULLS FIRST",
    )

    # The note can be dismissed.
    gone = client.delete(f"/api/datasets/{orders['id']}/notes/{note['id']}")
    assert gone.status_code == 204
    assert client.get(f"/api/datasets/{orders['id']}").json()["notes"] == []


def test_text_that_isnt_dates_is_refused(client: TestClient, orders: dict[str, Any]) -> None:
    response = update_columns(client, orders, {"status": {"is_temporal": True}})
    assert response.status_code == 400
    assert "don't look like dates" in response.json()["detail"]


# ---------- old time columns, checked lazily ----------


def mark_pending(
    session_factory: sessionmaker[Session], dataset_id: int, names: list[str], main: str
) -> None:
    """What migration 0012 leaves: number / text columns marked temporal before Part 13."""
    with session_factory() as db:
        for col in db.scalars(select(DatasetColumn).where(DatasetColumn.dataset_id == dataset_id)):
            if col.name in names:
                col.is_temporal = True
                col.time_kind = "pending"
        dataset = db.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.main_time_column = main
        db.commit()


def test_pending_columns_are_checked_when_the_dataset_opens(
    client: TestClient, orders: dict[str, Any], session_factory: sessionmaker[Session]
) -> None:
    mark_pending(session_factory, orders["id"], ["Year", "not_years"], main="not_years")
    dataset = client.get(f"/api/datasets/{orders['id']}").json()
    assert col_of(dataset, "Year")["time_kind"] == "year_number"
    not_years = col_of(dataset, "not_years")
    assert not not_years["is_temporal"] and not_years["time_kind"] is None
    assert dataset["main_time_column"] is None
    messages = [n["message"] for n in dataset["notes"]]
    assert any("“Year” holds years" in m for m in messages)
    assert any("“not_years” was marked as a time column" in m for m in messages)
    # Checked once: opening again adds nothing.
    again = client.get(f"/api/datasets/{orders['id']}").json()
    assert len(again["notes"]) == len(messages)


def test_pending_columns_are_checked_by_a_chart(
    client: TestClient, orders: dict[str, Any], session_factory: sessionmaker[Session]
) -> None:
    mark_pending(session_factory, orders["id"], ["Year"], main="Year")
    response = chart(client, "line", orders["id"], metrics=["count"], time={"grain": "year"})
    assert response.status_code == 200, response.text


def test_unchecked_columns_give_charts_a_clear_error(
    client: TestClient,
    orders: dict[str, Any],
    session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mark_pending(session_factory, orders["id"], ["Year"], main="Year")

    def unreachable(*args: Any) -> Any:
        raise QueryError("connection", "Couldn't connect")

    monkeypatch.setattr(datasets_api, "check_pending", unreachable)
    response = chart(client, "line", orders["id"], metrics=["count"], time={"grain": "year"})
    assert response.status_code == 400
    assert "couldn't be checked yet" in response.json()["detail"]["message"]
    # The dataset page still opens; the column stays pending (checked next time).
    dataset = client.get(f"/api/datasets/{orders['id']}").json()
    assert col_of(dataset, "Year")["time_kind"] == "pending"


# ---------- SQL on both dialects ----------


def year_dataset() -> Dataset:
    def col(name: str, kind: str, **extra: Any) -> DatasetColumn:
        return DatasetColumn(
            name=name, generic_type=kind, generic_type_override=None, is_dimension=False,
            is_hidden=False, is_missing=False, **extra,
        )  # fmt: skip

    return Dataset(
        kind="table", schema="s", table_name="games", main_time_column="Year",
        columns=[col("Year", "number", is_temporal=True, time_kind="year_number"),
                 col("day", "string", is_temporal=True, time_kind="text_date",
                     text_date_format="dmy")],
        metrics=[DatasetMetric(name="count", expression="COUNT(*)", is_builtin=True)],
    )  # fmt: skip


@pytest.mark.parametrize(
    ("db_type", "parts"),
    [
        ("postgresql", ['MAKE_DATE(CAST("Year" AS INT), 1, 1)', "DATE_TRUNC("]),
        ("mysql", ["MAKEDATE(`Year`, 1)", "YEAR("]),
    ],
)
def test_year_number_sql(db_type: str, parts: list[str]) -> None:
    built = build_chart_query(
        year_dataset(), db_type, "line",
        ChartQuery(dataset_id=1, metrics=["count"], time={"grain": "year"}),
    )  # fmt: skip
    for part in parts:
        assert part in built.sql
    assert "BETWEEN 1000 AND 9999" in built.sql  # never an error on a bad value


@pytest.mark.parametrize(
    ("db_type", "order", "parts"),
    [
        ("postgresql", "dmy", ["~ '^[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4}$'", "MAKE_DATE("]),
        ("postgresql", "ymd", ["~ '^[0-9]{4}[-/.]"]),
        ("mysql", "dmy", ["STR_TO_DATE(", "'%d-%m-%Y'"]),
        ("mysql", "mdy", ["'%m-%d-%Y'"]),
    ],
)
def test_text_date_sql(db_type: str, order: str, parts: list[str]) -> None:
    dialect = "postgres" if db_type == "postgresql" else "mysql"
    rendered = time_expression(column("day"), "text_date", order, db_type).sql(dialect=dialect)
    for part in parts:
        assert part in rendered


# ---------- friendly errors ----------


@pytest.mark.parametrize(
    ("kind", "raw", "title"),
    [
        ("not_found", "function date_trunc(unknown, bigint) does not exist",
         "A date function got a value that isn't a date"),
        ("not_found", "operator does not exist: bigint >= date",
         "A date function got a value that isn't a date"),
        ("other", "Incorrect DATE value: '2006'", "A date function got a value that isn't a date"),
        ("other", "division by zero", "Division by zero"),
        ("not_found", 'column "amount" does not exist', "Unknown column"),
        ("not_found", "Unknown column 'amount' in 'field list'", "Unknown column"),
        ("not_found", 'relation "sales.nope" does not exist', "Unknown table"),
        ("permission", "permission denied for table orders", "Permission denied"),
        ("timeout", "canceling statement due to statement timeout", "The query took too long"),
        ("connection", "server closed the connection unexpectedly", "The connection to the database was lost"),
        ("connection", "could not connect", "Couldn't reach the database"),
        ("syntax", 'syntax error at or near "FORM"', "The SQL has a syntax error"),
    ],
)  # fmt: skip
def test_errors_are_explained(kind: str, raw: str, title: str) -> None:
    explained = explain(kind, raw)
    assert explained is not None and explained[0] == title
    error = QueryError(kind, raw, raw=raw)  # type: ignore[arg-type]
    assert error.title == title and error.hint and error.raw == raw


def test_unknown_errors_keep_the_raw_message() -> None:
    error = QueryError("other", "something odd happened")
    assert error.title is None and error.hint is None and error.message == "something odd happened"


@pytest.mark.parametrize(
    ("sql", "title"),
    [
        ("SELECT date_trunc('year', 2006::bigint)", "A date function got a value that isn't a date"),
        ("SELECT 1 / (id - id) FROM sales.orders", "Division by zero"),
        ("SELECT nope FROM sales.orders", "Unknown column"),
        ("SELECT * FORM sales.orders", "The SQL has a syntax error"),
    ],
)  # fmt: skip
def test_sql_lab_errors_have_a_title_hint_and_the_raw_error(
    client: TestClient, connection_id: int, sql: str, title: str
) -> None:
    response = client.post("/api/query", json={"connection_id": connection_id, "sql": sql})
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["title"] == title
    assert detail["hint"]
    assert detail["message"]  # the detailed message is still there


def test_chart_errors_carry_the_raw_database_error(client: TestClient, connection_id: int) -> None:
    """The bug from real usage: a BIGINT year marked as time used to reach date_trunc. Now
    it can't be marked without becoming a year number, but a SQL dataset that calls
    date_trunc on a number itself still explains the error, with the raw text in Details."""
    response = client.post(
        "/api/datasets",
        json={"name": "Broken", "connection_id": connection_id, "kind": "sql",
              "sql": "SELECT date_trunc('year', 2006::bigint) AS y"},
    )  # fmt: skip
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["title"] == "A date function got a value that isn't a date"
    assert "date_trunc" in detail["raw"]
