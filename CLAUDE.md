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
10. **Fixes from real usage** — Customize tab, pie/donut, chart-data cache, value labels,
    schema diagram, 24-column grid with 8 resize handles, unsaved-chart warning *(done)*
11. **More chart types** (15) — chart type gallery, area, combo, treemap, funnel, gauge,
    pivot table (date buckets), heatmap (time parts), scatter / bubble, histogram, world map
    *(done)*

**Out of scope for v1:** dashboard filters, multi-user permissions, alerts, scheduled
reports, chart types beyond the 15 of Part 11.

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
  - `app/diagram.py` — one schema's tables, columns, PK/FK markers and foreign keys for the
    Browse diagram (`GET /api/connections/{id}/schemas/{schema}/diagram`). One inspector pass
    (`get_multi_*`), same `information_schema` fallback (which only shows constraints on tables
    the user has more than SELECT on); at most 1000 tables (`truncated`).
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
    `run.py`: preview, metric validation and `time_extent` (MIN/MAX of a time column; API
    `GET /api/datasets/{id}/time-extent?column=`), all via `run_query`.
    The user's type override is `generic_type_override` (sync refreshes `generic_type`).
    Columns can have `value_labels` ({"1": "Lethbridge"}): in column settings, omitted =
    unchanged, `{}` = clear; the frontend shows them in legends, axes, tables and pie slices.
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
    Pie and treemap (`build_top_n`): one metric, no grain, one dimension (treemap: one or two
    levels); `series_limit` = top N outer values, the rest is one row with `__other` = 1 (and
    every level NULL) computed in SQL (LEFT JOIN on the top N), so "Other" is right for AVG /
    COUNT DISTINCT too. Area = line, combo = bar's x axis without a series, funnel = one
    dimension + one metric, gauge = one total: all through `build`; `_check_shape` has the
    rules per type. Pivot tables (`build_pivot`): `dimensions` = rows, `column_dimensions` =
    columns (at most 3 / 2), metrics; with `totals` every (row prefix × column prefix) level
    is grouped **in SQL** (Postgres `GROUPING SETS`, one scan; MySQL has none: `UNION ALL`, one
    branch per level), each row tagged `__row_level` / `__col_level` (how many dims are
    grouped) so a real NULL is never a total. The browser only lays it out.
    Dimensions can be a date bucket or a time part of a time column: `"order_date@month"`
    (day / week / month / quarter / year: `time_bucket`, a DATE) or `"created_at@day_of_week"`
    (`timegrain.time_part`: day_of_week 1 = Monday ... 7 on both databases — Postgres
    `EXTRACT(ISODOW)`, MySQL `WEEKDAY() + 1` —, hour_of_day, month_of_year; integers).
    `_Builder.dim(ref)` resolves every dimension (all chart types, pivot rows / columns,
    series); the output column is named by the ref. No hour for plain DATE columns.
    Heatmap = two dimensions + one metric, ordered by both. Scatter = 2-3 metrics (x, y,
    size) + one dimension (a point each) + optional series (color), never a top-N join.
    World map = one dimension + one metric (matching countries is in the browser).
    Histogram (`build_histogram`, `ChartQuery.bins` = {column, count | width}): a fixed
    width bins FLOOR(x / width) (aligned to multiples, negatives fine); a number of bins
    splits [MIN, MAX] of the filtered rows (a CROSS JOIN on the bounds; MAX in the last bin;
    one distinct value = one bin; x cast to float first: MySQL rounds DECIMAL division). Rows
    without a value are bin NULL. Output `__bin`, `__bin_start`, `__bin_end`, metric; the
    range is computed outside the grouping (MySQL's ONLY_FULL_GROUP_BY). Chart-data responses carry `range_start`/`range_end`
    (the range filtered on, days inclusive). An ungrouped total over a time range gets a hidden
    last column `__first_time` = MIN(time column) (`rows_probe`); the API strips it and returns
    **no rows** when it is NULL, so "no data in the range" (big number shows "-" + the hint)
    never looks like a real total of 0.
    `cache.py`: chart-data cache in the metadata DB (`chart_cache`), key = sha256(connection id
    + its `updated_at`, final SQL, row limit), so a changed chart/dataset/connection never gets
    a stale result. Request `cache_ttl` (seconds, 0 = off, null = 10 min) and `refresh` (skip
    it); response `cached_at`. Writes drop expired entries and enforce the size cap
    (`VITA_CACHE_MAX_MB`, oldest first); results over 5 MB aren't cached. The insert commits
    first; cleanup runs behind `pg_try_advisory_xact_lock` (one at a time, others skip it:
    parallel cleanups deadlocked), and a failed cache write never fails the request. **Never** use it for
    SQL Lab.
    Query model: `app/schemas/charts.py`. API: `app/api/charts.py` (`POST /api/chart-data`,
    not logged; `/api/charts` CRUD, params = {query, display}). Charts → datasets FK RESTRICT.
    `tests/test_charts_mysql.py` runs only with `VITA_TEST_MYSQL_HOST` (throwaway mysql:8.4
    container on the compose network; see the file's docstring).
  - Dashboards: `app/api/dashboards.py` (`/api/dashboards`: list/get/create/update/delete,
    `/{id}/duplicate`, `/{id}/charts` appends a chart tile). `layout` JSON (schema in
    `app/schemas/dashboards.py`: 24-column grid, 14px rows, chart / text tiles; geometry and
    the 12→24 rescale in `app/dashboard_grid.py`, migration 0010 doubled x/y/w/h so old
    dashboards keep their exact pixels) is the source of truth; `cache_ttl` (null = each
    chart's own) applies to every tile;
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
    Tests: `client` is logged in, `anon_client` is not (they are the **same** TestClient: once
    `client` logs in, `anon_client` is logged in too; log out to test 401s). argon2 uses cheap
    params in tests. New tables must be added to the TRUNCATE in `tests/conftest.py`.
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
    SQL Lab's "Save as dataset" dialog, `ValueLabelsDialog`). Preview reuses `ResultsPane`.
  - Charts: `src/pages/ChartsPage.tsx`, `ChartEditorPage.tsx` (lazy-loaded with ECharts) +
    `src/charts/`. Pure, unit-tested logic: `model.ts` (editor state, `adaptToViz` when the
    chart type changes, `chartRequests`: a big number with trend sends two queries — the
    total without grain and the trend line), `options.ts` (pivot rows into series, ECharts
    options), `format.ts` (numeral.js formats like "0,0.00" / "0.0%", bucket labels by grain,
    NULL → "(empty)"; numbers may arrive as strings). `EChart.tsx` imports only the ECharts
    parts it uses (bundled, no CDN; bar, line, pie, treemap, funnel, gauge, title for the donut
    center, mark areas) and resizes with its container at most once per animation frame; page
    tests mock it. Canvas can't read CSS variables: ChartView resolves the series palette and
    `DrawContext.tokens` (text, border, danger / warning (ochre) / success, accent, surface)
    with `cssVar`, so charts never hold literal colors.
    Chart types: 15. Names in `vizTypes.ts` (tiny: the charts list and "Add chart"
    are in the main bundle); the gallery (`ChartTypePicker.tsx` + `VizThumb.tsx` static SVGs
    in theme colors, groups / descriptions / search in `vizGallery.ts`) is editor-only.
    Never import `model.ts` from a main-bundle page. `adaptToViz` keeps what fits;
    `switchReport` says what carried over and what didn't, `missingFor` what still needs
    setting (shown under the picker). Area and combo go through `cartesianLayout` (area:
    not stacked / stacked / 100% via `shares`, incomplete periods as a shaded band; combo:
    `comboSeries` bar/line + left/right axis per metric). Treemap / funnel / gauge options in
    `moreCharts.ts` (treemap outer boxes show their true value from a second query, like the
    donut total: `chartRequests` → `total` + `totalViz`; labels pick a readable token color
    with `readableOn`; funnel labels sit beside the steps). Pivot layout is pure
    (`pivotTable.ts`: header rows, groups, SQL totals, collapse, 50-column cap, heat levels
    `--heat-1..5`; date-bucket headers / rows of incomplete periods are dashed + italic with
    a footnote) + `PivotTable.tsx`. Gauge and big number show "-" + the hint with no rows.
    `dimensions.ts`: "column@part" refs (`splitDim`, labels "Mon" / "08:00" / "Mar 2026",
    `dimensionOptions` for pickers); `columnLabel` / `dimensionLabel` understand them.
    Heatmap / scatter / histogram options in `distribution.ts` (heatmap axes: every value
    of a time part, Monday first, else sorted; incomplete date buckets dashed; continuous
    color scale `scaleColors` = `--heat-2` tint → the two olives by contrast, empty cells and
    countries without data stay the card color; scatter keeps 9 colors + "Other"; histogram
    fills empty bins and says how many rows had no value). ChartView's `coverageFor` gives
    heatmaps and pivots the time extent of their first bucketed column.
    World map: `geo/WorldMapView.tsx` is lazy and loads `geo/world.json` (Natural Earth
    1:110m via world-atlas, no Antarctica, antimeridian stitched; ~55 kB gzipped, its own
    chunk) and registers it once. `geo/countryMatch.ts` matches ISO-2 / ISO-3 / names
    (accents, case, punctuation, "the" ignored) using `geo/countries.ts` (generated) and
    `geo/countryAliases.ts` (hand-written: add aliases there). Dataset value labels apply
    first, so the editor's "N values couldn't be matched" notice can be fixed with them.
    `scripts/build-world.mjs` regenerates world.json / countries.ts from dev-only packages
    (world-atlas, topojson-client, i18n-iso-countries).
    Side panel tabs: **Data** (`ChartControls.tsx`: what to query, debounced auto-update, cache
    setting) and **Customize** (`CustomizePanel.tsx`: the look, stored in `display`).
    `display.ts`: per-metric `FormatSpec` (chart format beats the metric's own; works for
    ad-hoc metrics), `unavailableOptions` (options that don't apply → disabled + hint),
    `drawState` (draw a loaded result with the **current** look: look options never query;
    only `mode`, `show_trend`, `compare_previous`, `donut` change data), previous-period
    ranges, incomplete first/last buckets (dotted line / lighter dashed bar; needs the time
    extent, cached in `extentCache.ts`), `planLabels` (never hide category labels silently:
    rotate ≤45°, cut with "…", say so and suggest horizontal bars). `load.ts`: `dataKey` (what
    needs a new query) and `loadChartData` (main + trend + previous period + donut total,
    cache options) for the editor and tiles alike. Value labels via `dimensionLabel` (model.ts).
    Results are drawn with the chart state they were made for (no stale result drawn as a
    different chart type). Saved charts store their time column explicitly.
    Unsaved changes: `components/useUnsavedChanges.ts` (`useBlocker` + `beforeunload`;
    `dirtyRef.current = false` right before navigating after a save) + `UnsavedChangesDialog`
    (Save / Discard / Stay) — used by the chart editor and the dashboard editor.
  - Dashboards: `src/pages/Dashboard(s)Page.tsx` (DashboardPage lazy-loaded) + `src/dashboards/`.
    Each `ChartTile` loads on its own through a per-page `RequestQueue` (4 at a time, tiles on
    screen first) and a shared `DatasetCache`; errors stay inside the tile (plus an error
    boundary). The first load of a tile may use the chart-data cache; every reload (Refresh,
    Refresh all, auto-refresh, Retry) passes `refresh`. `DashboardGrid.tsx` wraps
    react-grid-layout v2 (page tests mock it; `DashboardGrid.test.tsx` drives the real one):
    24 columns, resize from all 8 handles (`RESIZE_HANDLES`), minimum size per chart type
    (gauge 4×8, pivot 8×10, treemap / funnel / heatmap / scatter 6×12, world map 8×14, ...)
    (`minTileSize`); handles are hidden outside edit mode. Text tiles
    are markdown rendered by `markdown.ts` (marked + DOMPurify — always sanitize). Pure helpers
    in `layout.ts`. Narrow screens stack tiles (view mode). The router is a data router
    (`createBrowserRouter` in `main.tsx`) so pages can use `useBlocker`; tests of pages that
    use it need `createMemoryRouter`. "Edit chart" links to `/charts/:id?dashboard=<id>`.
  - Browse (`src/pages/BrowsePage.tsx`): List or Diagram view (`vita.browse.view`). The
    diagram (`src/browse/SchemaDiagram.tsx`, lazy, with dagre — keep both out of the main
    bundle) lays one schema out with `diagramLayout.ts` (pure: dagre layout, search,
    neighbors, identifier quoting); pan/zoom/glide are CSS transforms (reduced motion: none).
    Preview runs `SELECT * … LIMIT 20` through `/api/query`; "Open in SQL Lab" uses router state.
  - Connection tests show `TestResultMessage` (a "Connected" check, or `ErrorAlert`).
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
    token pair in both themes; add new pairs there when you add tokens. It also checks the
    10 chart series colors (`--series-1..10`): 3:1 on cards and CIEDE2000 ≥ 15 between any
    two (≥ 18 for neighbors). The first three stay orange / olive / dark olive. Pivot heat
    cells (`--heat-1..5`, an olive tint) keep `--text` at 4.5:1+.
  - Lint: `npm run lint` (ESLint flat config `eslint.config.js`, type-aware, max 0 warnings).
  - Tests: Vitest + Testing Library (`*.test.ts(x)` next to the code, setup in
    `src/test/setup.ts`). Monaco is mocked with a textarea in page tests.
    Radix menus open from the keyboard in tests (`keyDown Enter` on the trigger), not `click`;
    jsdom stubs (ResizeObserver, scrollIntoView, layout sizes) live in `setup.ts`.
    Radix Tabs switch on `mouseDown`, not `click`. CSS imports are empty under Vitest: read a
    stylesheet with `test/readSource.ts`. Don't import fixtures from a `*.test.ts` file (its
    tests would run twice); put them in a `testData.ts`.
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
- **CSS layers**: `styles/index.css` = vendor < theme < base (fonts, `base.css`, `App.css`) <
  components < utilities. Third-party CSS (react-grid-layout, react-resizable) is imported
  there into `vendor`, never from a component: unlayered CSS beats every layer, so App.css
  couldn't override it. No Tailwind preflight (base.css has the resets). Page-level styles
  live in `App.css` (organized by page); new components prefer Tailwind utilities.
- **Lazy chunks**: SQL Lab, chart editor, dashboard page, dataset editor, the schema diagram
  and the command palette are lazy-loaded; keep heavy libraries (Monaco, ECharts, TanStack,
  cmdk, Motion, dagre, chart code, the world map) out of the main bundle.

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
