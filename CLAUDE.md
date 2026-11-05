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
3. **Query engine** — run SQL with row limits, timeouts, clean errors *(done)*
4. **SQL editor** — Monaco, results table, schema browser, saved queries *(done)*
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
  - `app/query/` — the query engine. **Always use `run_query(details, sql, limit, timeout)`**
    to run SQL on a user database (chart builder too); never execute user SQL directly.
    Safety layers: sqlglot check (one statement, read queries only; `validate.py`), a
    read-only transaction that is always rolled back, server-side timeout + client-side
    guard, and at most limit + 1 rows fetched (Postgres server-side cursor; MySQL outer
    LIMIT capped). Errors are `QueryError(kind, message, line, column)`.
    Every run via the API is logged in `query_history`.
  - `app/browsing.py` — column metadata for a table. Falls back to `information_schema` on
    Postgres servers that deny access to system catalogs (e.g. public RNAcentral). Reuse it.
  - `app/crypto.py` — Fernet encryption of saved passwords (`VITA_SECRET_KEY`). Passwords are
    never returned by the API (only `has_password`); response schemas must not include them.
    `password_encrypted` NULL = no password. Save/test password rules: `clear_password` → none,
    non-empty password → use it, empty → keep the saved one.
  - `app/api/saved_queries.py` — saved queries CRUD (`/api/saved-queries`).
  - `app/datasets/` — datasets logic, no FastAPI imports (the chart builder reuses it);
    API in `app/api/datasets.py` (`/api/datasets`).
    `sql.py`: `from_clause` / `select_sql` build SQL with sqlglot only (always-quoted
    identifiers; kind=sql becomes `(<sql>) AS "virtual_table"`, keeping the user's own quoting).
    `checks.py`: SQL dataset check (Part 3 rules + must be a SELECT; warns on ORDER BY/LIMIT)
    and `parse_metric_expression` (exactly one expression; no clauses, alias or writes).
    `sync.py`: generic types come from cursor metadata of `SELECT * ... LIMIT 0`, never from
    row values; the merge keeps user settings and marks vanished columns `is_missing`.
    `run.py`: preview and metric validation, both via `run_query`.
    The user's type override is `generic_type_override` (sync refreshes `generic_type`).
    The built-in `count` metric (`is_builtin`) can't be deleted. Datasets → connections FK is
    RESTRICT; deleting a used connection returns 409 listing the datasets.
  - `app/charts/` — chart query builder (no FastAPI imports). `build_chart_query(dataset,
    db_type, viz_type, ChartQuery, today)` validates the query against the dataset and returns
    SQL built only from sqlglot ASTs on top of `from_clause`; run it with `run_query`.
    `timegrain.py` (bucket is always a DATE; Postgres `CAST(DATE_TRUNC(..) AS DATE)`, MySQL
    templates, weeks start Monday), `timerange.py` ([start, end) dates from `today`),
    `filters.py` (values become typed sqlglot literals; LIKE = contains, wildcards escaped).
    Series top-N is a JOIN on a derived table with `<=>` / `IS NOT DISTINCT FROM` (MySQL
    can't LIMIT inside IN). GROUP BY repeats expressions (Postgres would read an alias as the
    raw column); ORDER BY uses output names with explicit NULLS-lowest ordering (otherwise
    sqlglot emulates with CASE on MySQL). SQL gets `LIMIT row_limit + 1` so `truncated` is exact.
    Query model: `app/schemas/charts.py`. API: `app/api/charts.py` (`POST /api/chart-data`,
    not logged; `/api/charts` CRUD, params = {query, display}). Charts → datasets FK RESTRICT.
    `tests/test_charts_mysql.py` runs only with `VITA_TEST_MYSQL_HOST` (throwaway mysql:8.4
    container on the compose network; see the file's docstring).
- `frontend/` — Vite React TS app (`src/`, pages in `src/pages/`, typed API calls in
  `src/api.ts`); dev server proxies `/api` to the backend. Routing: react-router.
  - SQL Lab = `src/pages/SqlLabPage.tsx` (lazy-loaded) + `src/sqllab/`:
    `SqlEditor.tsx` (Monaco, bundled locally via `monacoSetup.ts` — no CDN; one
    ref-counted SQL completion provider for language id `sql`). `monacoSetup.ts` must keep
    importing `edcore.main`: `editor.api` alone has no suggest widget/hover/find, so
    autocomplete silently does nothing (`monacoSetup.test.ts` uses real Monaco to guard this), `schemaCache.ts` (per-connection metadata cache — use it instead of
    calling browse endpoints directly), `ResultsPane.tsx` (TanStack Table + Virtual grid),
    `tabs.ts` (tab state, localStorage `vita.sqllab.tabs.v1`), pure helpers in
    `completion.ts` / `results.ts` (unit-tested). SQL Lab opens a new tab from router state
    `{ openTab }` (`src/datasets/sqlLabLink.ts`); "Open in SQL Lab" uses it.
  - Datasets: `src/pages/Dataset*Page.tsx` + `src/datasets/` (Columns/Metrics/Preview tabs,
    SQL Lab's "Save as dataset" dialog). Preview reuses `ResultsPane`.
  - Charts: `src/pages/ChartsPage.tsx`, `ChartEditorPage.tsx` (lazy-loaded with ECharts) +
    `src/charts/`. Pure, unit-tested logic: `model.ts` (editor state, `adaptToViz` when the
    chart type changes, `chartRequests`: a big number with trend sends two queries — the
    total without grain and the trend line), `options.ts` (pivot rows into series, ECharts
    options), `format.ts` (numeral.js formats like "0,0.00" / "0.0%", bucket labels by grain,
    NULL → "(empty)"; numbers may arrive as strings). `EChart.tsx` imports only the ECharts
    parts it uses (bundled, no CDN) and resizes with its container; page tests mock it.
    Results are drawn with the chart state they were made for (no stale result drawn as a
    different chart type). Saved charts store their time column explicitly.
  - Tests: Vitest + Testing Library (`*.test.ts(x)` next to the code, setup in
    `src/test/setup.ts`). Monaco is mocked with a textarea in page tests.
- `sampledb/init/` — seed SQL for the demo database (`sales` schema: customers, products,
  orders, order_items, view order_totals; ~2 years of orders, deterministic).
- `docker-compose.yml` — `db` (Vita metadata), `sampledb` (demo data), `backend`, `frontend`.
  There is no login yet, so every published port is bound to `127.0.0.1` only; keep it that way.
- API endpoints are plain `def` (FastAPI runs them in a threadpool) so slow user queries don't
  block other requests. Don't make an endpoint `async def` if it does blocking DB calls
  (`tests/test_concurrency.py` guards this).

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
docker compose exec frontend npm run typecheck   # frontend type check (strict)
docker compose exec frontend npm test            # frontend tests (Vitest)
```
After adding frontend dependencies: `docker compose up -d --build -V frontend`.
No local Python is required; run Python tooling inside the `backend` container.
