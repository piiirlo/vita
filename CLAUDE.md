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
12. **CSV and Excel uploads** — a file becomes a table in the built-in Uploads database and a
    dataset. Round 1 *(done)*: CSV / TSV, the Uploads database and roles, the basic flow.
    Round 2 *(done)*: Excel, adjust panel polish, Replace / Append file, delete behavior,
    the dataset's file panel, uploads in backups.
13. **Fixes from real usage, round 2** — data correctness (year-number / text-date time
    columns, friendly query errors, raw grain and dimension x axis for line / area,
    code-like upload columns, readable upload dates); the chart editor (Data / Customize
    redesign, custom SQL metrics, conditional + per-series colors, big number position,
    save to a dashboard); dashboard free placement, auto-fit and Tidy up *(done)*

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

## Off-limits (confidential data)
- Never start, stop, rebuild, query, seed, back up, restore or
  screenshot the prod stack (docker-compose.prod.yml, project
  vita-prod, 127.0.0.1:8080). Use only the dev stack for all checks.
- Never connect to, query or inspect anything on port 5440 or the
  gold-local stack (C:\Projects\gold-local), and never read files in
  that folder.
- If a task seems to need the prod stack, stop and ask me.

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
    LIMIT capped). Errors are `QueryError(kind, message, line, column, title, hint, raw)`:
    `__post_init__` fills `title` / `hint` (plain language) from the kind and the database's
    text via `errors.explain` (type mismatch on date functions, unknown column / table /
    function, division by zero, permission, timeout, connection lost, syntax); unrecognized
    errors keep `title` None and show `message`. `raw` is the driver's own text ("Details").
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
  - File uploads: `app/uploads/` + `app/api/uploads.py` (`/api/uploads`).
    `bootstrap.py` creates at startup (idempotent, advisory lock; `VITA_UPLOADS_ON_STARTUP`)
    the database `vita_uploads` (`VITA_UPLOADS_DB`) on the metadata Postgres server, its
    schema `uploads`, the role `<db>_reader` (CONNECT + SELECT, `default_transaction_read_only`)
    and `<db>_writer` (CREATE in `uploads` only, owns its tables), revokes PUBLIC's CONNECT on
    both databases, and the built-in connection "Uploads" (`connections.builtin = "uploads"`,
    reader role; the API refuses to edit / delete it). Role passwords are an HMAC of
    VITA_SECRET_KEY, set again at every start. **Writes only through the writer's own psycopg
    connection** (`importer.py`: CREATE TABLE + COPY FROM STDIN, names as `sql.Identifier`),
    never through run_query; reads go through run_query like any connection.
    Flow: `POST /api/uploads` takes the **raw body** (X-File-Name header; an async endpoint
    only to stream to disk and stop at `VITA_UPLOAD_MAX_MB`), stores it under a random token
    (`files.py`, `VITA_UPLOAD_DIR`; deleted after import, on cancel, or after an hour), and
    returns the preview; `/{id}/preview` re-reads with options; `/{id}/import` starts a
    background task (progress in the `uploads` row, so any worker can answer `GET /{id}`),
    then a table dataset (columns synced, the first date column as time). The `uploads` table
    is the record: file, table, columns, rows, mode, bad values, warnings, user, dates.
    Reading (`reading.py`, csv module, streaming): encoding (BOM / strict UTF-8 /
    Windows-1252 if 0x80-0x9F / Latin-1), delimiter (, ; tab |), header, skip rows. Types
    (`types.py`: one parser for guessing, preview and import): text / integer / decimal /
    date / datetime / boolean; decimal comma and thousands separators (`detect_number_format`);
    dates: day/month order from values > 12, **ambiguous orders are never guessed** (a blocking
    problem until the user picks). Values that don't fit become NULL and are reported, or stop
    the import (`on_error: "stop"`). `preview.py` reports problems (misfits, garbled text,
    one giant column, ragged rows, ambiguous dates, no rows, too many columns): they open the
    adjust panel. Names: `names.py` (accents stripped, reserved words get "_", duplicates
    _2). Limits: `VITA_UPLOAD_MAX_ROWS`, `VITA_UPLOAD_MAX_COLUMNS`. Tests use the database
    `vita_uploads_test` (`uploads_db` fixture in tests/test_uploads.py); startup doesn't
    create the Uploads connection in tests (`no_uploads_on_startup` in conftest).
    Part 13 guessing: names like zip / postal / phone / code (`is_code_name`) and values
    with leading zeros stay text; id-named columns are text only when their values are;
    integers all in 1900-2100 report `years` ("name" when the name says year too). Words
    like N/A in non-text columns are counted (`null_words`) and reported in `bad_values`
    with `kind: "null_word"` (never a stop on error).
    Excel (`excel.py`, openpyxl read-only, opened from a file handle: stored uploads have no
    .xlsx extension): .xlsx only (old .xls / other zips → 415); the zip is checked before
    opening (`check_zip`: entries, total size, ratio); **formulas are never evaluated** (the
    cached value, else the formula as text: two workbooks, `data_only` True / False); cells
    become the same text the CSV reader gives (`cell_text`), so one set of parsers serves
    both; the first sheet with data is detected, `options.sheet` picks another. `open_source`
    (preview.py) is the one entry for both formats; text checks (garbled, one column) are CSV
    only. Replace / Append: `POST /api/uploads?dataset_id=&mode=replace|append` (a table
    dataset on the Uploads connection only); the preview matches file columns to the table's
    by name, case-insensitive (`_match_target`: matched keep the table's name and type,
    `locked`); missing columns block (`columns_mismatch`, `missing_columns`); extra columns
    block an append (a fresh guess leaves them out) and are added on replace. Replace fills
    `<table>__new` then DROP + RENAME in one transaction (same table name: labels, metrics,
    charts keep working); afterwards `_refresh_dataset` merges the columns and bumps the
    Uploads connection's `updated_at` (chart cache key). Datasets: `is_upload`, and
    `upload_source` (`app/uploads/datasets.py`: latest file, rows = last create / replace +
    appends after, history). `DELETE /api/datasets/{id}?drop_table=true` also drops the table
    (writer role; dropped before the commit, so a failed drop keeps the dataset), 409 while
    other datasets read it (table datasets on it, SQL datasets on Uploads naming it).
    Startup gives tables not owned by the writer back to it and re-grants the reader
    (restored backups come back owned by the admin).
  - Time columns that aren't dates (Part 13): `app/datasets/timecols.py`. A temporal
    column's `time_kind`: None (date / datetime), `year_number` (2006 → 2006-01-01: Postgres
    make_date, MySQL MAKEDATE; only the year grain), `text_date` (`text_date_format`
    ymd / dmy / mdy, - / . separators) or `pending`. **Every** use of a time column in SQL
    goes through `time_value(col, db_type)` (buckets, time parts, ranges, the rows probe,
    time extent); its expressions never raise on bad values (CASE-guarded, NULL instead).
    `pending` = number / text columns marked temporal before Part 13: checked lazily by
    `ensure_time_columns` (api/datasets.py: dataset page, Sync, preview, time extent, chart
    data), **never at startup** (no user-DB queries at startup, ever); results become
    dataset `notes` (dismissable, `DELETE /api/datasets/{id}/notes/{note_id}`). Marking a
    column temporal (`_time_kinds` in the update) is only for dates, numbers that are all
    years (1000-9999, checked by a query) and text that parses (counted failures → a note).
    Detection (upload, create, Sync; `merge_columns(..., stats)` with `number_stats`): a
    year-like name (`is_year_name`) + whole numbers 1900-2100 → a year time column; values
    alone → `looks_like_years` (the Columns tab suggests it). `is_identifier` (names like
    id / row_id / postal_code / rank): not offered for SUM / AVG.
    Charts: `TimeSpec.grain` may be `"raw"` (every time value, no bucket); line / area take
    a dimension x axis like bar (ordered by the dimension). `SqlMetric` (`{sql, label,
    number_format}`) is a third metric kind: `parse_metric_expression` checks (like saved
    metrics); `usage.sql_columns` protects the columns it names. `ChartOut.dashboards`
    (single-chart responses). `POST /api/dashboards/{id}/charts` uses
    `dashboard_grid.first_free_spot`. `dashboard_grid.compact_vertical` is react-grid-
    layout's vertical compaction ported step for step (migration 0013 stored every layout
    compacted once: tiles are placed freely since, so old dashboards keep their look;
    `frontend/scripts/rgl-compact-check.mjs` prints RGL's own results to compare).
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
  - Uploads: `src/pages/UploadPage.tsx` (lazy, `/datasets/upload`) + `src/uploads/`: pick or drop
    a file → preview (`PreviewTable`, bad cells dashed) → "Create dataset" → progress →
    the dataset (or a report of values left empty). `AdjustPanel` ("Adjust how the file is
    read") opens by itself on a new set of problems; read options re-guess the columns
    (`withReadOption` sets `columns: null`), column type / ignore / date order re-read with
    the columns, names don't re-read. `fileDrop.ts`: `useFileDrop` (drop anywhere on the
    Datasets page, overlay) and the picked file handed to the upload page. The file goes up
    with XHR (`uploadFile` in api.ts: upload progress). Ctrl+K has "Upload file"; the
    Connections list shows the built-in Uploads connection with a badge, no Edit / Delete.
    `?dataset=<id>&mode=replace|append` turns the page into Replace file / Append file (no
    name field, "Replace data" asks first, "Append rows"); locked columns can't change type
    or name, "new" / "not in the dataset" badges; Excel shows a sheet picker instead of the
    CSV options; "Reset to detected" (`sameReadOptions`). The dataset page shows
    `UploadSourcePanel` (file, rows, who / when, history, Replace / Append file) for upload
    datasets; `DeleteDatasetDialog` (Datasets list and dataset page) offers "Also delete its
    table" for them. The frontend is **not** Prettier-formatted: never run prettier on it.
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
    The Data panel (Part 13): sections in the order people think — What to measure, Break it
    down by, Over time, Filter, Sort & limit (a folded `<details>`, advanced options under
    "More options") — only those the chart type uses, each with a one-line hint while empty
    (`editorSections.ts`, pure: `sectionsFor`, `emptyHint`, `dropColumn` = what dropping a
    column on a section does, `targetsFor`). `ColumnPalette.tsx`: the dataset's columns
    (search, type icons from `columnKinds.ts`), draggable (`COLUMN_MIME`) and an "Add to…"
    menu (the keyboard way). Metrics: Simple or Custom SQL (`SqlMetricEditor.tsx`, column
    autocomplete in `sqlMetric.ts`, Validate via the metric validate endpoint, "Save to
    dataset" turns it into a saved metric). Customize groups: Labels & numbers, Colors, Axes
    & legend, Layout. Conditional colors (`colorRules.ts`): `display.color_rules` (above /
    below a value → success / danger / warning; first match wins; "Positive / negative" in
    one click; the big number's older `color_below` / `color_above` read as rules) on bars,
    points, slices, boxes, steps, table and pivot cells, the big number (not heatmap / world
    map / gauge: they have scales or bands); a colored value always shows its value with ▲ /
    ▼. `display.series_colors` (series / slice name → palette index). Big number position:
    `display.align` / `valign` (classes `big-number-h-*` / `big-number-v-*`, centered by
    default, hero tiles too). Saving: `charts/SaveChartDialog.tsx` (name, and optionally a
    dashboard: search existing or type a new name); the chart is saved first, then placed;
    toasts can carry an action (`toast.success(msg, {label, onClick})`, "Open dashboard").
    Query errors everywhere use `components/QueryErrorAlert.tsx` (`QueryErrorBody`: title,
    hint, "Details" with the raw error; helpers in `components/queryError.ts`). The editor
    checks the time column before running (`timeColumnProblem` in model.ts; year numbers
    have only the Year grain: `grainAllowed`, `YEARS_ONLY_HINT`).
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
    tiles are placed freely (Part 13): no forced compaction; `compactor.ts` pushes tiles that
    overlap down (cascading) and never up, the tile being dragged / resized keeping its
    place; "Tidy up" (`gridTidy.ts`) compacts on demand with RGL's own vertical compactor.
    Dropped into a gap, a tile fills it (`layout.ts` `fitToGap`: bounded below, within its
    minimum size, only when it moved); the dashed placeholder shows that size during the drag
    (onDrag sets it), onDragStop sets the final item. jsdom can't simulate RGL drags (no
    layout): `freePlacement.test.tsx` drives the grid's callbacks and RGL's `moveElement`.
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
  - Datasets (Part 13): the Columns tab shows "year (number)", a text date's format picker,
    "Looks like years, use as time?", and an identifier switch; the dataset page shows
    `notes`. The upload preview shows dates as "9 Nov 2013" (title: the file's text) with
    the detected format ("Day first: DD-MM-YYYY", a select) in the column header, and N/A
    counts / "years: a time column" notes (`uploads/uploads.ts` `readableDate`).
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
  (`-f docker-compose.prod.yml` for prod), plus `<name>.uploads.dump` (schema `uploads` of
  the Uploads database, `VITA_UPLOADS_DB` read from `.env`; no owners / grants: the backend
  restores them at startup). Restore takes a safety backup first. Backups also
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
