# CLAUDE.md

## Project goal
A self-hosted data visualization tool — a much simpler alternative to Apache Superset.
Connect a database, write SQL, turn results into charts, and put charts on dashboards.
Single user for now.

## Tech stack
- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2.x, Alembic (migrations), Pydantic (schemas)
- **App metadata DB:** PostgreSQL 16 — stores connections, queries, charts, dashboards
- **Frontend:** React + TypeScript + Vite
- **Later:** Apache ECharts (charts), Monaco (SQL editor), react-grid-layout (dashboard grid)
- **Runtime:** everything runs with Docker Compose

## Build plan
One part at a time, in order:

1. **Foundation** — repo, backend, frontend, DB, Docker *(done)*
2. **Database connections** — save, test, browse schemas/tables/columns; encrypted credentials *(done)*
3. **Query engine** — run SQL with row limits, timeouts, clean errors
4. **SQL editor** — Monaco, results table, schema browser, saved queries
5. **Datasets** — table or saved query + column metadata, time column
6. **Chart builder** — table, big number, bar, line; backend generates SQL from chart config
7. **Dashboards** — grid layout, save positions, refresh
8. **Polish** — simple login, loading/error states, CSV export

**Out of scope for v1:** dashboard filters, caching, multi-user permissions, alerts,
scheduled reports, extra chart types.

## Working rules
- Work on one part at a time. Don't start the next part unless asked.
- Keep things simple and readable over clever.
- TypeScript strict mode on the frontend; type hints everywhere in Python.
- Write pytest tests for backend endpoints.
- Secrets go in `.env` (with a committed `.env.example`), never in code.

### `superset-reference/`
This folder may contain the Apache Superset source code. It is **read-only reference material**:
- Read it to learn how Superset solves a problem, then write a simpler version here.
- Never import from it.
- If any code is copied directly, keep the Apache 2.0 license notice in that file.
- It must stay in `.gitignore`.

## Layout
- `backend/` — FastAPI app (`app/`), Alembic migrations (`alembic/`), tests (`tests/`)
  - `app/engines.py` — builds SQLAlchemy engines for *user* databases (NullPool, 5s connect
    timeout). Reuse it for anything that talks to a user DB (query engine, datasets, charts).
  - `app/db_errors.py` — turns driver errors into human-readable messages. Reuse it too.
  - `app/crypto.py` — Fernet encryption of saved passwords (`VITA_SECRET_KEY`). Passwords are
    never returned by the API; response schemas must not include them.
- `frontend/` — Vite React TS app (`src/`, pages in `src/pages/`, typed API calls in
  `src/api.ts`); dev server proxies `/api` to the backend. Routing: react-router.
- `sampledb/init/` — seed SQL for the demo database (`sales` schema: customers, products,
  orders, order_items, view order_totals; ~2 years of orders, deterministic).
- `docker-compose.yml` — `db` (Vita metadata), `sampledb` (demo data), `backend`, `frontend`

## Testing notes
- Backend tests run against a separate `vita_test` database (created and migrated
  automatically by `tests/conftest.py`), and use `sampledb` as a real user database.
- From inside Docker, the demo DB is host `sampledb` port 5432; a database on the Windows
  host is `host.docker.internal`.

## Commands
```sh
cp .env.example .env                       # first time only
docker compose up --build                  # start everything
docker compose exec backend pytest         # backend tests
docker compose exec backend alembic revision --autogenerate -m "msg"   # new migration
docker compose exec backend alembic upgrade head                       # apply migrations
docker compose exec frontend npx tsc -b    # frontend type check
```
No local Python is required; run Python tooling inside the `backend` container.
