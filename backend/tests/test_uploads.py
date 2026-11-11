"""File uploads end to end: a CSV becomes a table in the Uploads database and a dataset; the
Uploads connection is read-only; limits, errors and clean-up."""

import io
import re
import zipfile
from collections.abc import Callable, Iterator
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import Upload
from app.uploads import bootstrap, files

TEST_UPLOADS_DB = "vita_uploads_test"

FRENCH_CSV = (
    "Produit;Prix TTC;Quantité;Date de vente;Payé\n"
    "Crème brûlée;4,20;3;15/03/2024;oui\n"
    "Café;1 234,50;12;16/03/2024;non\n"
    "Pâté;0,99;1;31/03/2024;oui\n"
)


@pytest.fixture(scope="session")
def uploads_server() -> Iterator[bootstrap.UploadsServer]:
    original = settings.vita_uploads_db
    settings.vita_uploads_db = TEST_UPLOADS_DB
    try:
        yield bootstrap.ensure_database()
    finally:
        settings.vita_uploads_db = original


@pytest.fixture
def uploads_db(
    uploads_server: bootstrap.UploadsServer,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> bootstrap.UploadsServer:
    """An empty Uploads test database, its built-in connection, and a temp upload folder."""
    monkeypatch.setattr(settings, "vita_uploads_db", TEST_UPLOADS_DB)
    monkeypatch.setattr(settings, "vita_upload_dir", str(tmp_path / "uploads"))
    with psycopg.connect(bootstrap._admin_conninfo(TEST_UPLOADS_DB), autocommit=True) as admin:
        for (table,) in admin.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = %s", (bootstrap.SCHEMA,)
        ).fetchall():
            admin.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(bootstrap.SCHEMA, table)))
    with session_factory() as session:
        bootstrap.ensure_connection(session, uploads_server)
    return uploads_server


def upload(client: TestClient, content: str | bytes, name: str = "ventes.csv") -> Any:
    body = content.encode() if isinstance(content, str) else content
    return client.post("/api/uploads", content=body, headers={"X-File-Name": quote(name)})


def preview_of(
    client: TestClient, content: str | bytes, name: str = "ventes.csv"
) -> dict[str, Any]:
    response = upload(client, content, name)
    assert response.status_code == 201, response.text
    data: dict[str, Any] = response.json()
    return data


def do_import(client: TestClient, preview: dict[str, Any], **extra: Any) -> dict[str, Any]:
    body = {"options": preview["options"], "dataset_name": preview["dataset_name"], **extra}
    response = client.post(f"/api/uploads/{preview['upload_id']}/import", json=body)
    assert response.status_code == 202, response.text
    # TestClient runs the background task before returning: the job is finished.
    done = client.get(f"/api/uploads/{preview['upload_id']}")
    assert done.status_code == 200
    result: dict[str, Any] = done.json()
    return result


def uploads_connection_id(client: TestClient) -> int:
    connections: list[dict[str, Any]] = client.get("/api/connections").json()
    return int(next(c["id"] for c in connections if c["builtin"] == "uploads"))


def reader(server: bootstrap.UploadsServer) -> psycopg.Connection[Any]:
    return psycopg.connect(
        host=server.host, port=server.port, dbname=server.database, user=server.reader,
        password=server.password(server.reader),
    )  # fmt: skip


# ---------- the flow ----------


def test_a_french_csv_becomes_a_dataset_you_can_chart(
    client: TestClient, uploads_db: Any, session_factory: sessionmaker[Session]
) -> None:
    preview = preview_of(client, FRENCH_CSV, "Ventes mars 2024.csv")
    assert preview["dataset_name"] == "Ventes mars 2024"
    assert preview["detected"]["delimiter"] == ";" and preview["detected"]["decimal"] == ","
    assert [c["type"] for c in preview["columns"]] == [
        "text",
        "decimal",
        "integer",
        "date",
        "boolean",
    ]
    assert preview["problems"] == []

    job = do_import(client, preview)
    assert job["status"] == "done", job
    assert (job["row_count"], job["table_name"], job["bad_values"]) == (3, "ventes_mars_2024", [])
    assert not files.path_for(client_token(session_factory, preview["upload_id"])).exists()

    dataset = client.get(f"/api/datasets/{job['dataset_id']}").json()
    assert (dataset["name"], dataset["schema"], dataset["table_name"]) == (
        "Ventes mars 2024",
        "uploads",
        "ventes_mars_2024",
    )
    assert dataset["main_time_column"] == "date_de_vente"
    types = {c["name"]: c["generic_type"] for c in dataset["columns"]}
    assert types == {
        "produit": "string",
        "prix_ttc": "number",
        "quantite": "number",
        "date_de_vente": "date",
        "paye": "boolean",
    }

    chart = client.post("/api/chart-data", json={"viz_type": "big_number", "query": {
        "dataset_id": dataset["id"], "metrics": [{"column": "prix_ttc", "aggregate": "SUM"}]}})  # fmt: skip
    assert chart.status_code == 200, chart.text
    assert Decimal(str(chart.json()["rows"][0][0])) == Decimal("1239.69")
    rows = client.get(f"/api/datasets/{dataset['id']}/preview").json()["rows"]
    assert [r[0] for r in rows] == ["Crème brûlée", "Café", "Pâté"]  # accents survive

    with session_factory() as db:
        record = db.get(Upload, preview["upload_id"])
        assert record is not None
        assert (record.mode, record.file_name, record.user_id is not None) == (
            "create",
            "Ventes mars 2024.csv",
            True,
        )
        assert record.columns == [
            {"name": "produit", "type": "text", "source": 0},
            {"name": "prix_ttc", "type": "decimal", "source": 1},
            {"name": "quantite", "type": "integer", "source": 2},
            {"name": "date_de_vente", "type": "date", "source": 3},
            {"name": "paye", "type": "boolean", "source": 4},
        ]


def client_token(session_factory: sessionmaker[Session], upload_id: int) -> str:
    with session_factory() as db:
        record = db.get(Upload, upload_id)
        assert record is not None
        return record.token


def test_arabic_text_and_names(client: TestClient, uploads_db: Any) -> None:
    preview = preview_of(client, "المنتج,السعر\nتمر,12.5\nقهوة,30\n", "منتجات.csv")
    job = do_import(client, preview)
    assert job["status"] == "done", job
    assert job["table_name"] == "منتجات"
    rows = client.get(f"/api/datasets/{job['dataset_id']}/preview").json()
    assert [c["name"] for c in rows["columns"]] == ["المنتج", "السعر"]
    assert rows["rows"][0][0] == "تمر"


def test_columns_renamed_retyped_and_left_out(client: TestClient, uploads_db: Any) -> None:
    preview = preview_of(client, "id,amount,comment\n1,10,a\n2,20,b\n")
    columns = preview["options"]["columns"]
    columns[0]["ignore"] = True
    columns[1].update(name="montant", type="text")
    options = {**preview["options"], "columns": columns}
    job = do_import(client, {**preview, "options": options})
    assert job["status"] == "done", job
    dataset = client.get(f"/api/datasets/{job['dataset_id']}").json()
    assert [(c["name"], c["generic_type"]) for c in dataset["columns"]] == [
        ("montant", "string"),
        ("comment", "string"),
    ]


def test_bad_values_become_null_and_are_reported(client: TestClient, uploads_db: Any) -> None:
    rows = "\n".join(f"{i},{i}.5" for i in range(1, 40))
    preview = preview_of(client, f"id,amount\n{rows}\n40,oops\n41,12abc\n")
    job = do_import(client, preview)
    assert job["status"] == "done", job
    assert job["bad_values"] == [
        {
            "column": "amount",
            "count": 2,
            "examples": [{"row": 40, "value": "oops"}, {"row": 41, "value": "12abc"}],
        }
    ]
    assert job["row_count"] == 41
    nulls = client.post("/api/chart-data", json={"viz_type": "big_number", "query": {
        "dataset_id": job["dataset_id"], "metrics": ["count"],
        "filters": [{"column": "amount", "operator": "IS NULL"}]}})  # fmt: skip
    assert nulls.json()["rows"] == [[2]]


def test_stop_on_error_imports_nothing(
    client: TestClient, uploads_db: bootstrap.UploadsServer
) -> None:
    rows = "\n".join(f"{i},{i}.5" for i in range(1, 40))
    preview = preview_of(client, f"id,amount\n{rows}\n40,oops\n", "strict.csv")
    job = do_import(client, preview, on_error="stop")
    assert job["status"] == "failed"
    assert (
        job["error"]
        == 'Row 40, column "amount": "oops" isn\'t a valid decimal. Nothing was imported.'
    )
    assert job["dataset_id"] is None
    with reader(uploads_db) as conn:
        assert conn.execute("SELECT to_regclass('uploads.strict')").fetchone() == (None,)


def test_ambiguous_dates_block_the_import_until_answered(
    client: TestClient, uploads_db: Any
) -> None:
    preview = preview_of(client, "day,n\n03/04/2024,1\n01/02/2024,2\n")
    blocked = client.post(f"/api/uploads/{preview['upload_id']}/import",
                          json={"options": preview["options"], "dataset_name": "Days"})  # fmt: skip
    assert blocked.status_code == 400
    assert "read both as day/month and month/day" in blocked.json()["detail"]
    columns = preview["options"]["columns"]
    columns[0]["date_order"] = "mdy"
    answered = client.post(
        f"/api/uploads/{preview['upload_id']}/preview",
        json={**preview["options"], "columns": columns},
    )
    assert answered.json()["problems"] == []
    job = do_import(
        client, {**preview, "options": answered.json()["options"], "dataset_name": "Days"}
    )
    assert job["status"] == "done", job
    data = client.get(f"/api/datasets/{job['dataset_id']}/preview").json()
    assert data["rows"][0][0] == "2024-03-04"  # March 4th (month first)


def test_preview_with_other_options(client: TestClient, uploads_db: Any) -> None:
    preview = preview_of(client, FRENCH_CSV)
    wrong = client.post(f"/api/uploads/{preview['upload_id']}/preview",
                        json={**preview["options"], "delimiter": ",", "columns": None})  # fmt: skip
    data = wrong.json()
    assert [p["kind"] for p in data["problems"]] == ["one_column"]
    assert data["detected"]["delimiter"] == ";"  # what was detected stays known


def test_dataset_names_and_table_names_never_clash(client: TestClient, uploads_db: Any) -> None:
    first = do_import(client, preview_of(client, "a,b\n1,2\n", "data.csv"))
    second_preview = preview_of(client, "a,b\n3,4\n", "data.csv")
    assert second_preview["dataset_name"] == "data (2)"
    second = do_import(client, second_preview)
    assert (first["table_name"], second["table_name"]) == ("data", "data_2")
    taken = client.post(f"/api/uploads/{preview_of(client, 'a\n1\n')['upload_id']}/import",
                        json={"options": second_preview["options"], "dataset_name": "data"})  # fmt: skip
    assert taken.status_code == 409


# ---------- limits and bad files ----------


def test_size_limit(client: TestClient, uploads_db: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "vita_upload_max_mb", 1)
    big = "a,b\n" + "1,2\n" * 300_000  # 1.2 MB
    response = upload(client, big)
    assert response.status_code == 413
    assert response.json()["detail"] == "The file is larger than 1 MB, the most an upload can be."
    assert list(Path(settings.vita_upload_dir).glob("*.upload")) == []


def test_row_limit(client: TestClient, uploads_db: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "vita_upload_max_rows", 3)
    job = do_import(client, preview_of(client, "a\n1\n2\n3\n4\n"))
    assert job["status"] == "failed"
    assert job["error"] == "The file has more than 3 rows, the most one upload can have."


def test_column_limit(client: TestClient, uploads_db: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "vita_upload_max_columns", 500)
    header = ",".join(f"c{i}" for i in range(501))
    preview = preview_of(client, header + "\n" + ",".join("1" for _ in range(501)) + "\n")
    [problem] = preview["problems"]
    assert problem["kind"] == "too_many_columns" and problem["blocking"]
    blocked = client.post(f"/api/uploads/{preview['upload_id']}/import",
                          json={"options": preview["options"], "dataset_name": "Wide"})  # fmt: skip
    assert blocked.status_code == 400 and "at most 500" in blocked.json()["detail"]


@pytest.mark.parametrize(
    ("content", "status", "message"),
    [
        (b"PK\x03\x04rest-of-a-zip", 415, "This is a zip file, not an Excel workbook"),
        (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1old-xls", 415, "Old Excel files (.xls)"),
        (b"\x00\x01\x02binary", 415, "doesn't look like a CSV, TSV, TXT or Excel"),
        (b"", 400, "The file is empty."),
    ],
)
def test_bad_files(
    client: TestClient, uploads_db: Any, content: bytes, status: int, message: str
) -> None:
    response = upload(client, content, "x.csv")
    assert response.status_code == status
    assert message in response.json()["detail"]
    assert list(Path(settings.vita_upload_dir).glob("*.upload")) == []


def test_cancel_and_expiry_delete_the_file(
    client: TestClient, uploads_db: Any, session_factory: sessionmaker[Session]
) -> None:
    preview = preview_of(client, "a\n1\n")
    token = client_token(session_factory, preview["upload_id"])
    assert files.path_for(token).exists()
    assert client.delete(f"/api/uploads/{preview['upload_id']}").status_code == 204
    assert not files.path_for(token).exists()
    assert client.get(f"/api/uploads/{preview['upload_id']}").json()["status"] == "cancelled"

    from datetime import UTC, datetime, timedelta

    other = preview_of(client, "a\n1\n")
    token = client_token(session_factory, other["upload_id"])
    with session_factory() as db:
        assert files.expire_stale(db, now=datetime.now(UTC) + timedelta(hours=2)) == 1
    assert not files.path_for(token).exists()
    gone = client.post(
        f"/api/uploads/{other['upload_id']}/import",
        json={"options": other["options"], "dataset_name": "x"},
    )
    assert gone.status_code == 409


# ---------- the Uploads connection is read-only ----------


def test_uploads_connection_is_built_in(client: TestClient, uploads_db: Any) -> None:
    [conn] = [c for c in client.get("/api/connections").json() if c["builtin"]]
    assert (conn["name"], conn["builtin"], conn["database"]) == (
        "Uploads",
        "uploads",
        TEST_UPLOADS_DB,
    )
    assert (
        client.put(f"/api/connections/{conn['id']}", json={**conn, "name": "Mine"}).status_code
        == 403
    )
    deleted = client.delete(f"/api/connections/{conn['id']}")
    assert deleted.status_code == 403 and "managed by Vita" in deleted.json()["detail"]
    assert client.post(f"/api/connections/{conn['id']}/test").json() == {"ok": True, "error": None}


def test_uploads_are_select_only_through_run_query(
    client: TestClient, uploads_db: bootstrap.UploadsServer
) -> None:
    job = do_import(client, preview_of(client, "a,b\n1,2\n", "secure.csv"))
    conn_id = uploads_connection_id(client)
    ok = client.post(
        "/api/query", json={"connection_id": conn_id, "sql": 'SELECT * FROM uploads."secure"'}
    )
    assert ok.status_code == 200 and ok.json()["rows"] == [[1, 2]]
    for statement in ['DELETE FROM uploads."secure"', "CREATE TABLE uploads.evil (a int)",
                      'DROP TABLE uploads."secure"']:  # fmt: skip
        refused = client.post("/api/query", json={"connection_id": conn_id, "sql": statement})
        assert refused.status_code == 400, statement
    assert job["status"] == "done"


def test_the_reader_role_itself_cannot_write(
    uploads_db: bootstrap.UploadsServer, client: TestClient
) -> None:
    """Even outside run_query (direct SQL with the connection's own credentials)."""
    do_import(client, preview_of(client, "a\n1\n", "locked.csv"))
    for statement in [
        "CREATE TABLE uploads.evil (a int)",
        "INSERT INTO uploads.locked VALUES (2)",
        "DROP TABLE uploads.locked",
        "CREATE TABLE public.evil (a int)",
    ]:
        with reader(uploads_db) as conn:
            conn.execute("SET TRANSACTION READ WRITE")  # beat the read-only default
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(statement)
    with reader(uploads_db) as conn:
        assert conn.execute("SELECT count(*) FROM uploads.locked").fetchone() == (1,)


def test_the_upload_roles_cannot_open_the_metadata_database(
    uploads_db: bootstrap.UploadsServer,
) -> None:
    from sqlalchemy.engine import make_url

    metadata_db = make_url(settings.database_url).database
    for role in (uploads_db.reader, uploads_db.writer):
        with pytest.raises(psycopg.OperationalError, match="permission denied"):
            psycopg.connect(host=uploads_db.host, port=uploads_db.port, dbname=metadata_db,
                            user=role, password=uploads_db.password(role))  # fmt: skip


def test_uploads_need_login(anon_client: TestClient, uploads_db: Any) -> None:
    anon_client.post("/api/auth/logout")
    assert upload(anon_client, "a\n1\n").status_code == 401


# ---------- Excel ----------


def xlsx(sheets: dict[str, list[list[Any]]], cached: dict[str, str] | None = None) -> bytes:
    """An .xlsx with these sheets. `cached` = {"C2": "8.4"}: those formula cells of the first
    sheet with rows get a cached value (openpyxl never writes one; Excel does)."""
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    if not cached:
        return out.getvalue()
    index = next(i for i, rows in enumerate(sheets.values(), 1) if rows)
    patched = io.BytesIO()
    with zipfile.ZipFile(out) as src, zipfile.ZipFile(patched, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == f"xl/worksheets/sheet{index}.xml":
                text = data.decode()
                for ref, value in cached.items():
                    cell = re.compile(rf'(<c r="{ref}"[^>]*>)(<f>[^<]*</f>)(<v\s*/>|<v></v>)?')
                    text, n = cell.subn(rf"\g<1>\g<2><v>{value}</v>", text)
                    assert n == 1, (ref, text)
                data = text.encode()
            dst.writestr(item, data)
    return patched.getvalue()


def test_excel_sheets_types_and_formulas(client: TestClient, uploads_db: Any) -> None:
    workbook = xlsx(
        {
            "Cover": [],
            "Sales": [
                ["Product", "Price", "Double", "Sold at", "Paid", "Note"],
                ["Tea", 4.2, "=B2*2", datetime(2024, 3, 15), True, '=UPPER("x")'],
                ["Coffee", 3, "=B3*2", datetime(2024, 3, 16, 9, 30), False, "plain"],
            ],
            "Other": [["code", "qty"], ["A", 1], ["B", 2]],
        },
        cached={"C2": "8.4", "C3": "6"},
    )
    preview = preview_of(client, workbook, "Sales report.xlsx")
    assert preview["file_kind"] == "xlsx"
    assert preview["sheets"] == ["Cover", "Sales", "Other"]
    assert preview["options"]["sheet"] == "Sales"  # the first sheet with data
    assert preview["options"]["header"] is True
    assert [(c["name"], c["type"]) for c in preview["columns"]] == [
        ("product", "text"),
        ("price", "decimal"),
        ("double", "decimal"),  # cached values, never evaluated
        ("sold_at", "datetime"),
        ("paid", "boolean"),
        ("note", "text"),
    ]
    assert preview["rows"][0][2] == "8.4"
    assert preview["rows"][0][5] == '=UPPER("x")'  # no cached value: the formula as text
    assert preview["problems"] == []

    other = client.post(
        f"/api/uploads/{preview['upload_id']}/preview",
        json={**preview["options"], "sheet": "Other", "columns": None},
    )
    assert other.status_code == 200, other.text
    assert [c["name"] for c in other.json()["columns"]] == ["code", "qty"]
    missing = client.post(
        f"/api/uploads/{preview['upload_id']}/preview",
        json={**preview["options"], "sheet": "Nope", "columns": None},
    )
    assert missing.status_code == 400 and "no sheet named" in missing.json()["detail"]

    job = do_import(client, preview)
    assert job["status"] == "done", job
    assert job["row_count"] == 2
    with reader(uploads_db) as conn:
        rows = conn.execute(
            sql.SQL("SELECT price, double, sold_at, paid, note FROM {} ORDER BY price").format(
                sql.Identifier(bootstrap.SCHEMA, job["table_name"])
            )
        ).fetchall()
    assert rows == [
        (Decimal(3), Decimal(6), datetime(2024, 3, 16, 9, 30), False, "plain"),
        (Decimal("4.2"), Decimal("8.4"), datetime(2024, 3, 15), True, '=UPPER("x")'),
    ]


def test_excel_zip_bomb_is_refused(client: TestClient, uploads_db: Any) -> None:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", "<workbook/>")
        z.writestr("xl/worksheets/sheet1.xml", "0" * 20_000_000)
    response = upload(client, out.getvalue(), "bomb.xlsx")
    assert response.status_code == 400
    assert "unpacks to far more data" in response.json()["detail"]


# ---------- replace / append ----------

SALES_CSV = "region,amount,sold_on\n1,10,2024-01-05\n2,20,2024-01-06\n"


@pytest.fixture
def sample_connection_id(
    client: TestClient, sampledb_payload: Callable[..., dict[str, Any]]
) -> int:
    response = client.post("/api/connections", json=sampledb_payload())
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def uploaded_dataset(
    client: TestClient, content: str = SALES_CSV, name: str = "sales.csv"
) -> dict[str, Any]:
    job = do_import(client, preview_of(client, content, name))
    assert job["status"] == "done", job
    dataset: dict[str, Any] = client.get(f"/api/datasets/{job['dataset_id']}").json()
    return dataset


def upload_into(
    client: TestClient, dataset: dict[str, Any], content: str, mode: str, name: str = "new.csv"
) -> Any:
    return client.post(
        f"/api/uploads?dataset_id={dataset['id']}&mode={mode}",
        content=content.encode(),
        headers={"X-File-Name": name},
    )


def total(client: TestClient, dataset_id: int, metric: Any = "total_amount") -> Decimal:
    response = client.post("/api/chart-data", json={"viz_type": "big_number", "query": {
        "dataset_id": dataset_id, "metrics": [metric]}})  # fmt: skip
    assert response.status_code == 200, response.text
    return Decimal(str(response.json()["rows"][0][0]))


SUM_AMOUNT = {"column": "amount", "aggregate": "SUM"}


def test_replace_keeps_labels_metrics_and_charts(
    client: TestClient, uploads_db: bootstrap.UploadsServer
) -> None:
    dataset = uploaded_dataset(client)
    assert dataset["is_upload"] is True
    region = next(c for c in dataset["columns"] if c["name"] == "region")
    keys = ("id", "label", "generic_type_override", "is_temporal", "is_dimension", "is_hidden",
            "description")  # fmt: skip
    labels = {"1": "North", "2": "South"}
    response = client.put(f"/api/datasets/{dataset['id']}", json={
        "name": dataset["name"], "description": None, "main_time_column": "sold_on",
        "columns": [{**{k: region[k] for k in keys}, "value_labels": labels}]})  # fmt: skip
    assert response.status_code == 200, response.text
    metric = client.post(f"/api/datasets/{dataset['id']}/metrics",
                         json={"name": "total_amount", "expression": "SUM(amount)"})  # fmt: skip
    assert metric.status_code == 201, metric.text
    chart = client.post("/api/charts", json={"name": "Sales total", "viz_type": "big_number",
        "params": {"query": {"dataset_id": dataset["id"], "metrics": ["total_amount"]}}})  # fmt: skip
    assert chart.status_code == 201, chart.text
    assert total(client, dataset["id"]) == 30  # now in the chart-data cache

    # Columns in another order and case, plus a new one.
    csv = "Sold_On,Amount,Region,Channel\n2024-02-01,5,1,web\n2024-02-02,7.5,3,shop\n"
    response = upload_into(client, dataset, csv, "replace")
    assert response.status_code == 201, response.text
    preview = response.json()
    assert (preview["mode"], preview["target"]["id"]) == ("replace", dataset["id"])
    assert preview["dataset_name"] == dataset["name"]
    assert preview["missing_columns"] == []
    status = {c["name"]: c["status"] for c in preview["columns"]}
    assert status == {"sold_on": "matched", "amount": "matched", "region": "matched",
                      "channel": "new"}  # fmt: skip
    amount = next(c for c in preview["columns"] if c["name"] == "amount")
    assert (amount["locked"], amount["type"]) == (True, "integer")  # the table's type
    kinds = sorted(p["kind"] for p in preview["problems"])
    assert kinds == ["columns_mismatch", "misfit"]  # "Channel will be added"; 7.5 isn't an integer
    assert not any(p["blocking"] for p in preview["problems"])

    job = do_import(client, preview)
    assert job["status"] == "done", job
    assert job["dataset_id"] == dataset["id"]
    assert [b["column"] for b in job["bad_values"]] == ["amount"]

    after = client.get(f"/api/datasets/{dataset['id']}").json()
    assert after["table_name"] == dataset["table_name"]
    region_after = next(c for c in after["columns"] if c["name"] == "region")
    assert region_after["value_labels"] == labels
    assert "channel" in {c["name"] for c in after["columns"]}
    assert {m["name"] for m in after["metrics"]} == {"count", "total_amount"}
    assert after["main_time_column"] == "sold_on"
    assert total(client, dataset["id"]) == 5  # the cache didn't serve the old data
    assert client.get(f"/api/charts/{chart.json()['id']}").status_code == 200

    source = after["upload_source"]
    assert (source["file_name"], source["row_count"]) == ("new.csv", 2)
    assert [e["mode"] for e in source["history"]] == ["replace", "create"]
    assert source["uploaded_by"] is not None
    with reader(uploads_db) as conn:
        tables = [r[0] for r in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'uploads'")]  # fmt: skip
    assert tables == [dataset["table_name"]]  # no leftover __new table


def test_replace_with_missing_columns_is_blocked(client: TestClient, uploads_db: Any) -> None:
    dataset = uploaded_dataset(client)
    preview = upload_into(client, dataset, "region,total\n1,3\n", "replace").json()
    assert preview["missing_columns"] == ["amount", "sold_on"]
    problem = next(p for p in preview["problems"] if p["kind"] == "columns_mismatch")
    assert problem["blocking"] and "“amount”, “sold_on”" in problem["message"]
    response = client.post(f"/api/uploads/{preview['upload_id']}/import",
                           json={"options": preview["options"], "dataset_name": "x"})  # fmt: skip
    assert response.status_code == 400 and "no column for" in response.json()["detail"]
    assert total(client, dataset["id"], SUM_AMOUNT) == 30  # untouched


def test_append_adds_rows(client: TestClient, uploads_db: Any) -> None:
    dataset = uploaded_dataset(client)
    csv = "region,amount,sold_on\n3,12,2024-01-07\n"
    preview = upload_into(client, dataset, csv, "append").json()
    assert preview["problems"] == [] and preview["dataset_name"] == dataset["name"]
    job = do_import(client, preview)
    assert job["status"] == "done", job
    assert total(client, dataset["id"], SUM_AMOUNT) == 42
    source = client.get(f"/api/datasets/{dataset['id']}").json()["upload_source"]
    assert source["row_count"] == 3
    assert [(e["mode"], e["rows"]) for e in source["history"]] == [("append", 1), ("create", 2)]


def test_append_column_mismatch(client: TestClient, uploads_db: Any) -> None:
    dataset = uploaded_dataset(client)
    csv = "region,amount,sold_on,notes\n3,1,2024-01-07,hi\n"
    preview = upload_into(client, dataset, csv, "append").json()
    # A fresh guess leaves the extra column out: appending works as it is.
    notes = next(c for c in preview["columns"] if c["name"] == "notes")
    assert (notes["status"], notes["ignore"]) == ("extra", True)
    assert not any(p["blocking"] for p in preview["problems"])
    # Keeping it is blocked, naming it.
    columns = [{**c, "ignore": False} for c in preview["options"]["columns"]]
    kept = client.post(f"/api/uploads/{preview['upload_id']}/preview",
                       json={**preview["options"], "columns": columns}).json()  # fmt: skip
    problem = next(p for p in kept["problems"] if p["kind"] == "columns_mismatch")
    assert problem["blocking"] and "“notes”" in problem["message"]
    # So is a file without one of the table's columns.
    short = upload_into(client, dataset, "region,amount\n3,1\n", "append").json()
    assert short["missing_columns"] == ["sold_on"]
    assert any(p["blocking"] for p in short["problems"])


def test_replace_and_append_only_for_uploaded_datasets(
    client: TestClient, uploads_db: Any, sample_connection_id: int
) -> None:
    other = client.post("/api/datasets", json={"name": "Customers",
        "connection_id": sample_connection_id, "kind": "table", "schema": "sales",
        "table_name": "customers"})  # fmt: skip
    assert other.status_code == 201, other.text
    response = upload_into(client, other.json(), "a\n1\n", "replace")
    assert response.status_code == 400 and "uploaded file" in response.json()["detail"]
    assert client.post("/api/uploads?mode=append", content=b"a\n1\n").status_code == 400
    dataset = uploaded_dataset(client)
    url = f"/api/uploads?dataset_id={dataset['id']}"
    assert client.post(url, content=b"a\n1\n").status_code == 400  # a dataset, but mode create


# ---------- deleting ----------


def table_exists(server: bootstrap.UploadsServer, table: str) -> bool:
    with reader(server) as conn:
        row = conn.execute(
            "SELECT count(*) FROM pg_tables WHERE schemaname = 'uploads' AND tablename = %s",
            (table,),
        ).fetchone()
    return row == (1,)


def test_delete_dataset_and_its_table(
    client: TestClient, uploads_db: bootstrap.UploadsServer
) -> None:
    dataset = uploaded_dataset(client)
    assert client.delete(f"/api/datasets/{dataset['id']}?drop_table=true").status_code == 204
    assert client.get(f"/api/datasets/{dataset['id']}").status_code == 404
    assert not table_exists(uploads_db, dataset["table_name"])

    kept = uploaded_dataset(client, name="kept.csv")
    assert client.delete(f"/api/datasets/{kept['id']}").status_code == 204
    assert table_exists(uploads_db, kept["table_name"])  # the table stays by default


def test_delete_table_blocked_while_other_datasets_use_it(
    client: TestClient, uploads_db: bootstrap.UploadsServer, sample_connection_id: int
) -> None:
    dataset = uploaded_dataset(client)
    table = dataset["table_name"]
    uploads_id = uploads_connection_id(client)
    twin = client.post("/api/datasets", json={"name": "Twin", "connection_id": uploads_id,
        "kind": "table", "schema": "uploads", "table_name": table})  # fmt: skip
    assert twin.status_code == 201, twin.text
    query = client.post("/api/datasets", json={"name": "By region", "connection_id": uploads_id,
        "kind": "sql", "sql": f"SELECT region, SUM(amount) AS s FROM uploads.{table} GROUP BY region"})  # fmt: skip
    assert query.status_code == 201, query.text

    blocked = client.delete(f"/api/datasets/{dataset['id']}?drop_table=true")
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["datasets"] == ["By region", "Twin"]
    assert client.get(f"/api/datasets/{dataset['id']}").status_code == 200
    assert table_exists(uploads_db, table)

    # Without its table it's a plain delete; other datasets have no table to delete.
    assert client.delete(f"/api/datasets/{dataset['id']}").status_code == 204
    customers = client.post("/api/datasets", json={"name": "Customers",
        "connection_id": sample_connection_id, "kind": "table", "schema": "sales",
        "table_name": "customers"}).json()  # fmt: skip
    assert client.delete(f"/api/datasets/{customers['id']}?drop_table=true").status_code == 400
    assert client.get(f"/api/datasets/{customers['id']}").status_code == 200


def test_startup_repairs_tables_restored_from_a_backup(
    uploads_db: bootstrap.UploadsServer,
) -> None:
    # restore.sh restores with --no-owner --no-acl: tables belong to the admin, the reader
    # has no grant. Startup gives them back to the writer and the reader.
    with psycopg.connect(bootstrap._admin_conninfo(TEST_UPLOADS_DB), autocommit=True) as admin:
        admin.execute("CREATE TABLE uploads.restored (n integer)")
        admin.execute("INSERT INTO uploads.restored VALUES (1), (2)")
    with reader(uploads_db) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("SELECT count(*) FROM uploads.restored")
    bootstrap.ensure_database()
    with reader(uploads_db) as conn:
        assert conn.execute("SELECT count(*) FROM uploads.restored").fetchone() == (2,)
    with psycopg.connect(bootstrap.writer_conninfo()) as conn:
        owner = conn.execute(
            "SELECT tableowner FROM pg_tables WHERE schemaname = 'uploads' AND tablename = 'restored'"
        ).fetchone()
        assert owner == (uploads_db.writer,)
        conn.execute("DROP TABLE uploads.restored")  # the writer owns it now
        conn.commit()
