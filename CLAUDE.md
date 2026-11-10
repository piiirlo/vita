# CLAUDE.md

## Project goal
A self-hosted data visualization tool — a much simpler alternative to Apache Superset.
Connect a database, write SQL, turn results into charts, and put charts on dashboards.
Single user for now.

## Tech stack
- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2.x, Alembic (migrations), Pydantic (schemas)
- **App metadata DB:** PostgreSQL 16 — stores connections, queries, charts, dashboards
- **Frontend:** React + TypeScript + Vite, Tailwind CSS v4, Radix primitives (shadcn-style, in
  `src/components/ui/`), lucide-react icons, cmdk (command palette), Motion (count-up only)
- **Charts / editor / grid:** Apache ECharts, Monaco, react-grid-layout
- **Runtime:** everything runs with Docker Compose

## Build plan
One part at a time, in order:

1. **Foundation** — repo, backend, frontend, DB, Docker *(done)*
2. **Database connections** — save, test, browse schemas/tables/columns; encrypted credentials *(done)*
3. **Query engine** — run SQL with row limits, timeouts, clean errors *(done)*
4. **SQL editor** — Monaco, results table, schema browser, saved queries *(done)*
5. **Datasets** — table or saved query + column metadata, time column
6. **Chart builder** — table, big number, bar, line; backend generates SQL from chart config
7. **Dashboards** — grid layout, save positions, refresh *(done)*
8. **Polish** — simple login, loading/error states, CSV export *(done)*
9. **Visual redesign ("Observatory")** — tokens, shell, every page; no feature changes *(done)*

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
  - Dashboards: `app/api/dashboards.py` (`/api/dashboards`: list/get/create/update/delete,
    `/{id}/duplicate`, `/{id}/charts` appends a chart tile). `layout` JSON (schema in
    `app/schemas/dashboards.py`: 12-column grid, chart / text tiles) is the source of truth;
    `dashboard_charts` is rebuilt from it on every save (chart_id FK RESTRICT), so deleting a
    used chart returns 409 "used by N dashboards" and the DB blocks it too. Dashboard endpoints
    never query user DBs: the frontend loads each tile via `/api/charts/{id}` + `/api/chart-data`.
  - Login: `app/auth.py` (argon2 hashing, sessions, failed-login throttling; no FastAPI) and
    `app/api/auth.py` (`/api/auth/login|logout|me|password`, `require_user`). Every router
    except health and auth is included with `dependencies=[Depends(require_user)]` in
    `app/main.py`: **new routers must be added there the same way**
    (`tests/test_auth.py` checks every /api route). Session cookie `vita_session` holds a
    random token; the DB stores only its SHA-256. Throttling state is in the DB
    (`login_failures`) so it works across workers. The admin user is created on startup from
    `VITA_ADMIN_*` and never overwritten (`python -m app.reset_password` for that).
    Tests: `client` is logged in, `anon_client` is not; argon2 uses cheap params in tests.
  - Lint/types: `ruff check .`, `ruff format .`, `mypy .` (strict, pydantic plugin; config in
    `pyproject.toml`). sqlglot 30 type hints use `exp.Expr` (the base class), not
    `exp.Expression`.
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
  - Dashboards: `src/pages/Dashboard(s)Page.tsx` (DashboardPage lazy-loaded) + `src/dashboards/`.
    Each `ChartTile` loads on its own through a per-page `RequestQueue` (4 at a time, tiles on
    screen first) and a shared `DatasetCache`; errors stay inside the tile (plus an error
    boundary). `DashboardGrid.tsx` wraps react-grid-layout v2 (page tests mock it). Text tiles
    are markdown rendered by `markdown.ts` (marked + DOMPurify — always sanitize). Pure helpers
    in `layout.ts`. Narrow screens stack tiles (view mode). The router is a data router
    (`createBrowserRouter` in `main.tsx`) so pages can use `useBlocker`; tests of pages that
    use it need `createMemoryRouter`. "Edit chart" links to `/charts/:id?dashboard=<id>`.
  - App shell (`App.tsx`): login gate (`auth/`: `AuthProvider` in `AuthContext.tsx`,
    `useAuth`/`safeNext` in `auth.ts`). Any API 401 fires `UNAUTHORIZED_EVENT` (api.ts) and
    sends the user to `/login?next=…`. Routes are wrapped in an `ErrorBoundary` keyed by path.
    `src/shell/`: `Rail` (72px icon rail, bottom bar on phones; theme toggle + account menu),
    `PageHeader` (eyebrow, title, search capsule, actions — use it on every page),
    `CommandPaletteHost` (Ctrl/Cmd+K; lazy-loads `CommandPalette`, cmdk).
  - Shared UI: `components/toast.ts` (`toast.success/error/info` from anywhere; one
    `<Toaster />` (Radix Toast) in the shell; use it for saves, deletes and errors),
    `ConfirmDialog` (Radix AlertDialog; never `window.confirm`/`alert`), `Modal` from
    `components/ui/dialog.tsx` for every other dialog, `EmptyState` (icon, one friendly line,
    one action), `usePageTitle("…")` in every page (tab title "X · Vita"). Primitives in
    `components/ui/` (Button, Input, Select, Dialog, AlertDialog, DropdownMenu, Tabs, Tooltip,
    Skeleton, ErrorAlert); class recipes in `ui/variants.ts`; `cn()` in `lib/cn.ts`.
  - Theme: `src/theme/theme.ts` (light / dark / system, localStorage `vita.theme` in try/catch,
    `data-theme` on <html>). `index.html` repeats the logic inline so there is no flash; keep
    them in sync. ECharts themes come from the tokens at runtime (`charts/echartsTheme.ts`,
    `EChart` rebuilds on theme change); Monaco themes too (`sqllab/monacoTheme.ts`, needs the
    `*.sql` token rules because vs-dark has its own).
  - Contrast: `npm run check:contrast` (`scripts/contrast.mjs`) checks every text/background
    token pair in both themes; add new pairs there when you add tokens.
  - Lint: `npm run lint` (ESLint flat config `eslint.config.js`, type-aware, max 0 warnings).
  - Tests: Vitest + Testing Library (`*.test.ts(x)` next to the code, setup in
    `src/test/setup.ts`). Monaco is mocked with a textarea in page tests.
    Radix menus open from the keyboard in tests (`keyDown Enter` on the trigger), not `click`;
    jsdom stubs (ResizeObserver, scrollIntoView, layout sizes) live in `setup.ts`.
- `sampledb/init/` — seed SQL for the demo database (`sales` schema: customers, products,
  orders, order_items, view order_totals; ~2 years of orders, deterministic).
- `docker-compose.yml` — `db` (Vita metadata), `sampledb` (demo data), `backend`, `frontend`.
  Every published port is bound to `127.0.0.1` only; keep it that way.
- `docker-compose.prod.yml` — production (project name `vita-prod`, separate data): nginx
  (`frontend/Dockerfile.prod`, `frontend/nginx.conf`, proxies `/api`) on 127.0.0.1:8080,
  backend without reload (`INSTALL_DEV=false`, migrations then `--workers`, `--proxy-headers`),
  `sampledb` only with `--profile demo`. Use a list-form `command:` (folded YAML broke args).
- `scripts/backup.sh` / `scripts/restore.sh` — pg_dump / pg_restore of the metadata DB
  (`-f docker-compose.prod.yml` for prod). Restore takes a safety backup first. Backups also
  need `VITA_SECRET_KEY`. `.sh` files must stay LF (`.gitattributes`).
- API endpoints are plain `def` (FastAPI runs them in a threadpool) so slow user queries don't
  block other requests. Don't make an endpoint `async def` if it does blocking DB calls
  (`tests/test_concurrency.py` guards this).

## Design ("Observatory")
Calm, earthy, instrument-like; **one** loud signal color. Mockups: `design/*.dc.html`.
- **Colors only from tokens** (`frontend/src/styles/tokens.css`): CSS variables on `:root`
  (light) and `[data-theme="dark"]`. No literal colors in components or CSS; Tailwind's own
  palette is disabled, utilities map to tokens (`bg-surface`, `text-muted`, `border-border`,
  `text-accent-text`…). Need a new color? Add a token in both themes + a contrast pair.
- **Orange** `--accent` (#FF5A22) is for the one primary action per screen, the live dot,
  focus and highlights. Text **on** orange is always dark (`--accent-fg`), never white.
  Orange text on light backgrounds uses `--accent-text`; links use `--link` (olive in light,
  soft orange in dark). Hero big numbers sit on the ink card (`--surface-ink`).
- **Errors never rely on color**: danger color + icon + the word "Error" (`ErrorAlert`, the
  `.alert-error` class, toasts).
- **Contrast**: text >= 4.5:1, large text (24px+) and UI parts >= 3:1. The light focus ring is
  `--accent-text` because #FF5A22 is only 2.86:1 on the light page.
- **Fonts** (bundled with @fontsource, no CDN): Space Grotesk for UI; JetBrains Mono for every
  number, SQL, type labels and small uppercase labels (`.eyebrow`: 11-12px, .14em tracking).
- **Shape**: cards 22px (`rounded-card`), controls 12px (`rounded-control`), pills 999px.
- **Motion**: UI feedback 150-250 ms, ease `cubic-bezier(.2,.7,.2,1)` (`--ease-out`); page
  enter = fade + 12px rise (`.page-enter`); lists / tiles stagger 70 ms on first mount only
  (`.stagger-item` / `.tile-enter` + `data-enter={index}`, CSS so it composes with the
  grid's transforms); skeleton shimmer, never spinners; card hover = lift 2px + accent glow
  (`.card-hover`); big numbers count up once (`CountUp`). `prefers-reduced-motion` turns all
  of it off (CSS rule in `styles/components.css`, `useReducedMotion` in JS). Keep Motion
  (`motion/react`) out of the main bundle: CSS first.
- **Focus**: every interactive element shows the `--focus-ring` (`:focus-visible`); Escape
  closes dialogs, menus and the palette (Radix does this; keep it).
- **CSS layers**: `styles/index.css` = theme < base (fonts, `base.css`, `App.css`) <
  components < utilities. No Tailwind preflight (base.css has the resets). Page-level styles
  live in `App.css` (organized by page); new components prefer Tailwind utilities.
- **Lazy chunks**: SQL Lab, chart editor, dashboard page, dataset editor and the command
  palette are lazy-loaded; keep heavy libraries (Monaco, ECharts, TanStack, cmdk, Motion) out
  of the main bundle.

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
docker compose exec backend ruff check . && docker compose exec backend mypy .   # lint + types
docker compose exec backend alembic revision --autogenerate -m "msg"   # new migration
docker compose exec backend alembic upgrade head                       # apply migrations
docker compose exec frontend npm run typecheck   # frontend type check (strict)
docker compose exec frontend npm test            # frontend tests (Vitest)
docker compose exec frontend npm run lint        # ESLint
docker compose exec frontend npm run check:contrast   # token contrast (WCAG)
docker compose -f docker-compose.prod.yml up -d --build   # production stack
```
After adding frontend dependencies: `docker compose up -d --build -V frontend`.
No local Python is required; run Python tooling inside the `backend` container.
