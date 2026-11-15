"""Part 14: projects own their connections, uploads, datasets, saved queries, charts and
dashboards; references stay inside one project; deleting one needs its name; migration 0014
moves everything that existed into "My workspace"."""

from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from alembic import command
from app.models import Connection

Make = Callable[..., dict[str, Any]]
BACKEND_DIR = Path(__file__).resolve().parent.parent


def new_project(client: TestClient, name: str) -> int:
    response = client.post("/api/projects", json={"name": name})
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def new_connection(client: TestClient, payload: Make, project_id: int | None, **extra: Any) -> int:
    response = client.post("/api/connections", json=payload(project_id=project_id, **extra))
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def new_dataset(client: TestClient, connection_id: int, name: str = "Orders", **extra: Any) -> Any:
    return client.post(
        "/api/datasets",
        json={"name": name, "connection_id": connection_id, "kind": "table",
              "schema": "sales", "table_name": "orders", **extra},
    )  # fmt: skip


def new_chart(client: TestClient, dataset_id: int, name: str = "Total", **extra: Any) -> Any:
    return client.post(
        "/api/charts",
        json={"name": name, "viz_type": "big_number",
              "params": {"query": {"dataset_id": dataset_id, "metrics": ["count"]}}, **extra},
    )  # fmt: skip


def tile(chart_id: int) -> dict[str, Any]:
    return {"id": f"c{chart_id}", "type": "chart", "chart_id": chart_id,
            "x": 0, "y": 0, "w": 12, "h": 16}  # fmt: skip


@pytest.fixture
def two_projects(client: TestClient, sampledb_payload: Make) -> dict[str, dict[str, int]]:
    """Sales and Ops, each with a connection, a dataset and a chart (same names in both)."""
    out: dict[str, dict[str, int]] = {}
    for name in ("Sales", "Ops"):
        project = new_project(client, name)
        connection = new_connection(client, sampledb_payload, project)
        dataset = new_dataset(client, connection)
        assert dataset.status_code == 201, dataset.text
        assert dataset.json()["project_id"] == project
        chart = new_chart(client, dataset.json()["id"])
        assert chart.status_code == 201, chart.text
        assert chart.json()["project_id"] == project
        out[name] = {"project": project, "connection": connection,
                     "dataset": dataset.json()["id"], "chart": chart.json()["id"]}  # fmt: skip
    return out


def test_project_crud(client: TestClient) -> None:
    created = client.post("/api/projects", json={"name": "  Sales 2024 "})
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "Sales 2024"
    assert body["dashboard_count"] == 0 and body["sources"] == [] and body["dashboards"] == []

    duplicate = client.post("/api/projects", json={"name": "sales 2024"})
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "A project with that name already exists."
    assert client.post("/api/projects", json={"name": "   "}).status_code == 400

    other = new_project(client, "Other")
    assert client.put(f"/api/projects/{other}", json={"name": "SALES 2024"}).status_code == 409
    renamed = client.put(f"/api/projects/{other}", json={"name": "Ops"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Ops"
    assert [p["name"] for p in client.get("/api/projects").json()] == ["Sales 2024", "Ops"]
    assert client.get("/api/projects/999").status_code == 404


def test_items_without_a_project_go_to_the_default_one(
    client: TestClient, sampledb_payload: Make
) -> None:
    """API clients from before projects keep working: everything lands in "My workspace"."""
    connection = new_connection(client, sampledb_payload, None)
    projects = client.get("/api/projects").json()
    assert [p["name"] for p in projects] == ["My workspace"]
    workspace = projects[0]["id"]
    assert client.get(f"/api/connections/{connection}").json()["project_id"] == workspace
    dataset = new_dataset(client, connection).json()
    assert dataset["project_id"] == workspace
    assert new_chart(client, dataset["id"]).json()["project_id"] == workspace
    dashboard = client.post("/api/dashboards", json={"name": "Overview", "layout": []})
    assert dashboard.json()["project_id"] == workspace
    saved = client.post("/api/saved-queries", json={"name": "q", "sql": "SELECT 1"})
    assert saved.json()["project_id"] == workspace


def test_lists_filter_by_project_and_names_are_per_project(
    client: TestClient, two_projects: dict[str, dict[str, int]]
) -> None:
    sales, ops = two_projects["Sales"], two_projects["Ops"]
    for path in ("connections", "datasets", "charts"):
        listed = client.get(f"/api/{path}", params={"project_id": sales["project"]}).json()
        assert [item["id"] for item in listed] == [sales[path[:-1]]], path
        assert len(client.get(f"/api/{path}").json()) == 2  # no filter: everything

    # "Overview" in both projects; twice in one is a conflict.
    for p in (sales, ops):
        made = client.post(
            "/api/dashboards",
            json={"name": "Overview", "layout": [tile(p["chart"])], "project_id": p["project"]},
        )
        assert made.status_code == 201, made.text
    again = client.post(
        "/api/dashboards", json={"name": "overview", "layout": [], "project_id": ops["project"]}
    )
    assert again.status_code == 409
    listed = client.get("/api/dashboards", params={"project_id": ops["project"]}).json()
    assert [d["name"] for d in listed] == ["Overview"]
    assert new_dataset(client, ops["connection"]).status_code == 409  # "Orders" again

    summary = client.get(f"/api/projects/{sales['project']}").json()
    assert summary["dashboard_count"] == 1 and summary["chart_count"] == 1
    assert summary["dataset_count"] == 1 and summary["connection_count"] == 1
    assert summary["sources"] == ["database"]
    assert [(d["name"], d["chart_count"]) for d in summary["dashboards"]] == [("Overview", 1)]


def test_references_stay_inside_a_project(
    client: TestClient, two_projects: dict[str, dict[str, int]]
) -> None:
    sales, ops = two_projects["Sales"], two_projects["Ops"]
    # A dataset only on its project's connections.
    wrong = new_dataset(client, ops["connection"], "X", project_id=sales["project"])
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "The connection belongs to another project."
    # A chart only on its project's datasets, also when edited.
    wrong = new_chart(client, ops["dataset"], "X", project_id=sales["project"])
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "The chart's dataset belongs to another project."
    moved = client.put(
        f"/api/charts/{sales['chart']}",
        json={"name": "Total", "viz_type": "big_number",
              "params": {"query": {"dataset_id": ops["dataset"], "metrics": ["count"]}}},
    )  # fmt: skip
    assert moved.status_code == 400
    # A dashboard only shows its project's charts (create, update, add chart).
    wrong = client.post(
        "/api/dashboards",
        json={"name": "D", "layout": [tile(ops["chart"])], "project_id": sales["project"]},
    )
    assert wrong.status_code == 400
    assert "another project" in wrong.json()["detail"]
    dashboard = client.post(
        "/api/dashboards", json={"name": "D", "layout": [], "project_id": sales["project"]}
    ).json()
    added = client.post(
        f"/api/dashboards/{dashboard['id']}/charts", json={"chart_id": ops["chart"]}
    )
    assert added.status_code == 400
    ok = client.post(f"/api/dashboards/{dashboard['id']}/charts", json={"chart_id": sales["chart"]})
    assert ok.status_code == 200, ok.text
    # Saved queries: the connection's project.
    saved = client.post(
        "/api/saved-queries",
        json={"name": "q", "sql": "SELECT 1", "connection_id": ops["connection"],
              "project_id": sales["project"]},
    )  # fmt: skip
    assert saved.status_code == 400
    saved = client.post(
        "/api/saved-queries",
        json={"name": "q", "sql": "SELECT 1", "connection_id": ops["connection"]},
    )
    assert saved.json()["project_id"] == ops["project"]
    listed = client.get("/api/saved-queries", params={"project_id": sales["project"]}).json()
    assert listed == []


def test_the_builtin_uploads_connection_is_shared(
    client: TestClient, session_factory: sessionmaker[Session], two_projects: dict[str, Any]
) -> None:
    with session_factory() as db:
        db.add(Connection(name="Uploads", db_type="postgresql", host="db", port=5432,
                          database="x", username="x", builtin="uploads"))  # fmt: skip
        db.commit()
    for p in two_projects.values():
        listed = client.get("/api/connections", params={"project_id": p["project"]}).json()
        assert sorted(c["name"] for c in listed) == ["Sample DB", "Uploads"]
        uploads = next(c for c in listed if c["builtin"])
        assert uploads["project_id"] is None


def test_delete_a_project_needs_its_name(
    client: TestClient, two_projects: dict[str, dict[str, int]]
) -> None:
    sales, ops = two_projects["Sales"], two_projects["Ops"]
    client.post("/api/dashboards",
                json={"name": "Overview", "layout": [tile(sales["chart"])],
                      "project_id": sales["project"]})  # fmt: skip
    client.post("/api/saved-queries",
                json={"name": "q", "sql": "SELECT 1", "connection_id": sales["connection"]})  # fmt: skip
    url = f"/api/projects/{sales['project']}"
    assert client.delete(url).status_code == 400
    refused = client.delete(url, params={"confirm": "sales"})
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Type the project's name exactly to delete it."
    assert client.get(url).status_code == 200

    assert client.delete(url, params={"confirm": "Sales"}).status_code == 204
    assert client.get(url).status_code == 404
    for path in ("connections", "datasets", "charts", "dashboards", "saved-queries"):
        remaining = client.get(f"/api/{path}").json()
        assert all(item["project_id"] == ops["project"] for item in remaining), path
    assert client.get(f"/api/charts/{ops['chart']}").status_code == 200
    assert [p["name"] for p in client.get("/api/projects").json()] == ["Ops"]


# ---------- migration 0014 ----------

MIGRATE_DB = "vita_migrate_test"


@pytest.fixture
def migrate_engine(test_engine: Engine) -> Iterator[tuple[Engine, Config]]:
    """A fresh database (next to vita_test) migrated to 0013, before projects."""
    url = test_engine.url
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{MIGRATE_DB}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{MIGRATE_DB}"'))
    target = url.set(database=MIGRATE_DB)
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option(
        "sqlalchemy.url", target.render_as_string(hide_password=False).replace("%", "%%")
    )
    command.upgrade(cfg, "0013")
    engine = create_engine(target)
    yield engine, cfg
    engine.dispose()
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{MIGRATE_DB}" WITH (FORCE)'))
    admin.dispose()


OWNED = ("connections", "uploads", "datasets", "saved_queries", "charts", "dashboards")


def test_migration_moves_everything_into_my_workspace(
    migrate_engine: tuple[Engine, Config],
) -> None:
    engine, cfg = migrate_engine
    with engine.begin() as db:
        db.execute(text(
            "INSERT INTO connections (id, name, db_type, host, port, database, username, builtin)"
            " VALUES (1, 'Sample', 'postgresql', 'h', 5432, 'd', 'u', NULL),"
            " (2, 'Uploads', 'postgresql', 'h', 5432, 'u', 'r', 'uploads')"
        ))  # fmt: skip
        db.execute(text(
            "INSERT INTO saved_queries (id, name, connection_id, sql) VALUES (1, 'q', 1, 'SELECT 1')"
        ))  # fmt: skip
        db.execute(text(
            "INSERT INTO datasets (id, name, connection_id, kind, schema, table_name) VALUES"
            " (1, 'Orders', 1, 'table', 'sales', 'orders'),"
            " (2, 'File', 2, 'table', 'uploads', 'file')"
        ))  # fmt: skip
        db.execute(text(
            "INSERT INTO charts (id, name, dataset_id, viz_type, params) VALUES"
            " (1, 'Total', 1, 'big_number', '{\"query\": {}}')"
        ))  # fmt: skip
        db.execute(text(
            "INSERT INTO dashboards (id, name, layout, refresh_interval) VALUES (1, 'Overview',"
            " '[{\"id\": \"a\", \"type\": \"chart\", \"chart_id\": 1, \"x\": 0, \"y\": 0,"
            " \"w\": 12, \"h\": 16}]', 'off')"
        ))  # fmt: skip
        db.execute(text("INSERT INTO dashboard_charts (dashboard_id, chart_id) VALUES (1, 1)"))
        db.execute(text(
            "INSERT INTO uploads (id, token, file_name, file_size, file_kind, status, mode,"
            " rows_done, progress, bad_values, warnings, dataset_id) VALUES"
            " (1, 't', 'file.csv', 10, 'csv', 'done', 'create', 3, 1.0, '[]', '[]', 2)"
        ))  # fmt: skip
        before = {t: db.execute(text(f"SELECT * FROM {t} ORDER BY id")).mappings().all()
                  for t in OWNED}  # fmt: skip

    command.upgrade(cfg, "head")

    with engine.connect() as db:
        projects = db.execute(text("SELECT id, name FROM projects")).all()
        assert [p.name for p in projects] == ["My workspace"]
        workspace = projects[0].id
        for table in OWNED:
            after = db.execute(text(f"SELECT * FROM {table} ORDER BY id")).mappings().all()
            assert len(after) == len(before[table]), table
            for old, new in zip(before[table], after, strict=True):
                # Nothing lost or changed; only the project added.
                assert {k: new[k] for k in old} == dict(old), table
                expected = None if table == "connections" and old["builtin"] else workspace
                assert new["project_id"] == expected, table
        links = db.execute(text("SELECT dashboard_id, chart_id FROM dashboard_charts")).all()
        assert [tuple(r) for r in links] == [(1, 1)]


def test_the_setup_draft_is_kept_until_cleared(client: TestClient) -> None:
    project = new_project(client, "Sales")
    assert client.get(f"/api/projects/{project}").json()["setup_draft"] is None
    draft = {"step": "query", "source": "db", "connection_id": 3, "sql": "SELECT 1"}
    saved = client.put(f"/api/projects/{project}/setup-draft", json={"draft": draft})
    assert saved.status_code == 200, saved.text
    assert saved.json()["setup_draft"] == draft
    assert client.get("/api/projects").json()[0]["setup_draft"] == draft
    too_big = {"sql": "x" * 300_000}
    assert (
        client.put(f"/api/projects/{project}/setup-draft", json={"draft": too_big}).status_code
        == 400
    )
    assert client.delete(f"/api/projects/{project}/setup-draft").status_code == 204
    assert client.get(f"/api/projects/{project}").json()["setup_draft"] is None
    assert client.put("/api/projects/999/setup-draft", json={"draft": {}}).status_code == 404
