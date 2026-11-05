# Vita

A small, self-hosted data visualization tool — a much simpler alternative to Apache Superset.
Connect a database, write SQL, turn results into charts, put charts on dashboards.

**Status:** Part 4: connections (PostgreSQL, MySQL), a read-only query engine, and SQL Lab,
a SQL editor with autocomplete, a schema browser, saved queries and history.

## Requirements
- Docker with Docker Compose

## Run it
```sh
cp .env.example .env
# Edit .env: change the passwords, and set VITA_SECRET_KEY. Generate a key with:
docker compose run --rm --no-deps backend python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

docker compose up --build
```

| What            | URL / address                      |
|-----------------|------------------------------------|
| App             | http://localhost:5173              |
| Health endpoint | http://localhost:8000/api/health   |
| API docs        | http://localhost:8000/docs         |
| Vita metadata DB| `localhost:5433` (from your host)  |
| Demo DB         | `localhost:5434` (from your host)  |

All ports listen on `127.0.0.1` only (there's no login yet), so other machines on your
network can't reach Vita.

Both backend (uvicorn `--reload`) and frontend (Vite) hot-reload when you edit files.
Migrations run automatically (`alembic upgrade head`) when the backend container starts.

> **Keep `VITA_SECRET_KEY` safe.** Saved connection passwords are encrypted with it.
> If it changes, re-enter the passwords of your saved connections.

## Demo database
The `sampledb` service is a Postgres database with a seeded `sales` schema
(customers, products, orders, order_items, and an `order_totals` view; ~800 orders over two years).
Add it in Vita as a connection:

| Field    | Value                                  |
|----------|----------------------------------------|
| Type     | PostgreSQL                             |
| Host     | `sampledb`                             |
| Port     | `5432`                                 |
| Database | value of `SAMPLEDB_DB` in `.env`       |
| Username | value of `SAMPLEDB_USER` in `.env`     |
| Password | value of `SAMPLEDB_PASSWORD` in `.env` |

The seed script only runs when the volume is first created. To re-seed from scratch:
```sh
docker compose rm -sf sampledb
docker volume rm vitaproject_sampledb-data
docker compose up -d sampledb
```

## Connecting to your own databases
The backend runs inside Docker, so `localhost` there means the backend container itself.
For a database running on your own (Windows) machine, use the host **`host.docker.internal`**.

## SQL Lab
Open http://localhost:5173/sql-lab.

| Action | How |
|---|---|
| Run the query (or only the selected text) | **Ctrl+Enter** (Cmd+Enter on Mac) or ▶ Run |
| Stop waiting for a query | ■ Stop (the database stops it at its 30 s timeout) |
| Save the tab as a saved query / update it | **Ctrl+S** or Save |
| Autocomplete | type, or Ctrl+Space; after `alias.` you get that table's columns |
| Insert a table/column name | click it in the Schema panel |
| Look at a table | hover it in the Schema panel → Preview |
| Sort results | click a column header (asc → desc → off) |
| Copy a value | click a cell, then Ctrl+C |
| Close a tab | × or middle-click |

Open tabs are kept in your browser (localStorage), so a page refresh doesn't lose your work.
Results are not kept; run the query again after a refresh.

## Running queries (API)
`POST /api/query` with `{"connection_id": 1, "sql": "SELECT ...", "limit": 1000}`.

- One statement per run, read queries only (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN).
- Every query runs in a read-only transaction that is rolled back afterwards.
- Up to 1,000 rows by default (max 10,000); `truncated: true` means there were more.
- Queries are stopped after 30 seconds.
- Every run is logged: `GET /api/query-history?limit=50&offset=0`.

> **Use a read-only database user for your connections.** Vita's checks block writes, but
> a read-only transaction can't stop everything (for example, functions with side effects
> such as `pg_terminate_backend()`). The database's own permissions are the real protection.

## Tests
```sh
docker compose exec backend pytest
docker compose exec frontend npm run typecheck
docker compose exec frontend npm test
```
Backend tests use a separate `vita_test` database, so they don't touch your saved connections.

## Migrations
```sh
docker compose exec backend alembic revision --autogenerate -m "describe change"
docker compose exec backend alembic upgrade head
```

## Layout
```
backend/    FastAPI app, Alembic migrations, pytest tests
frontend/   React + TypeScript + Vite
sampledb/   seed SQL for the demo database
docker-compose.yml
```

If you add dependencies to `frontend/package.json`, rebuild with `docker compose up --build -V`
(`-V` recreates the `node_modules` volume).
