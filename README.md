# Vita

Vita is a small, self-hosted data visualization tool: a much simpler alternative to
Apache Superset. Connect a database, explore it with SQL, turn query results into charts,
and put the charts on dashboards.

- **Connections** to PostgreSQL and MySQL. Passwords are stored encrypted.
- **SQL Lab**: a SQL editor with autocomplete, a schema browser, saved queries and history.
  Queries are read-only, row-limited and time-limited.
- **Datasets**: a table, or a saved SQL query, plus column settings and reusable metrics.
- **Charts**: table, big number, bar and line charts. Vita writes the SQL for you.
- **Dashboards**: drag-and-drop grid of charts and text, with auto-refresh.
- **Login**: one admin user, with password change and protection against password guessing.

Vita is single-user for now (v1).

---

## Contents
- [Requirements](#requirements)
- [Configuration](#configuration)
- [Run it for development](#run-it-for-development)
- [Run it in production](#run-it-in-production)
- [First login](#first-login)
- [Build your first dashboard](#build-your-first-dashboard)
- [Backups and restore](#backups-and-restore)
- [Connecting to your own databases](#connecting-to-your-own-databases)
- [SQL Lab keyboard shortcuts](#sql-lab-keyboard-shortcuts)
- [Development: tests, lint, migrations](#development-tests-lint-migrations)

## Requirements
- Docker with Docker Compose v2.
- To run the backup scripts: a `bash` shell. On Windows, Git Bash works.

## Configuration
All settings live in `.env`. Create it once from the example:

```sh
cp .env.example .env
```

Then edit `.env`:

| Setting | What it is |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Vita's own metadata database. Change the password. Keep `DATABASE_URL` in sync with it. |
| `VITA_SECRET_KEY` | Encrypts saved connection passwords. **Required.** Generate it once (command below) and **back it up**. |
| `VITA_ADMIN_USERNAME`, `VITA_ADMIN_PASSWORD` | The admin user, created on first start. The password needs at least 8 characters. |
| `VITA_SESSION_DAYS` | How long a login lasts. The default is 7 days. |
| `VITA_COOKIE_SECURE` | `auto` (default) makes the session cookie HTTPS-only unless Vita is opened on `localhost` or `127.0.0.1`. You can also set `true` or `false`. |
| `SAMPLEDB_*` | The demo database. |

Generate `VITA_SECRET_KEY`:

```sh
docker compose run --rm --no-deps backend python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

> **Keep `VITA_SECRET_KEY` safe and never change it.** Saved connection passwords are
> encrypted with it. If it's lost or changed, those passwords can't be decrypted and have to
> be re-entered for every connection.

## Run it for development

```sh
docker compose up --build
```

| What | Address |
|---|---|
| App (Vite dev server, hot reload) | http://localhost:5173 |
| API docs | http://localhost:8000/docs |
| Vita metadata DB | `localhost:5433` (from your machine) |
| Demo DB | `localhost:5434` (from your machine) |

Both the backend (uvicorn `--reload`) and the frontend (Vite) reload when you edit files.
Database migrations run automatically when the backend starts. Every port listens on
`127.0.0.1` only.

## Run it in production

`docker-compose.prod.yml` runs Vita from built files:
- the frontend is built to static files and served by **nginx**, which also proxies `/api`
  to the backend
- the backend runs **without hot reload**, with several worker processes (`VITA_WORKERS`,
  default 4)
- **migrations run on startup**
- every service restarts automatically (`restart: unless-stopped`)

```sh
# First time: create and fill in .env (see Configuration), then:
docker compose -f docker-compose.prod.yml up -d --build

# The same, plus the demo database (used in the walkthrough below):
docker compose -f docker-compose.prod.yml --profile demo up -d --build
```

Open **http://127.0.0.1:8080**.

- **Port and address.** By default the app listens on `127.0.0.1:8080`, so only this
  machine can reach it. Change that with `VITA_HTTP_PORT` and `VITA_BIND_ADDRESS` in `.env`.
  Before opening Vita to a network, **put it behind an HTTPS reverse proxy**, for example
  Caddy, Traefik or nginx with a certificate. The login cookie is then sent over HTTPS only.
- **Separate data.** The production stack has its own project name (`vita-prod`), so its
  containers and data are separate from the development stack. To copy your development
  data over, back it up from dev and restore it into prod (see
  [Backups and restore](#backups-and-restore)).
- **Updating.** Run `git pull`, then
  `docker compose -f docker-compose.prod.yml up -d --build`. Migrations run automatically.
- **Logs:** `docker compose -f docker-compose.prod.yml logs -f backend`.
- **Stopping:** `docker compose -f docker-compose.prod.yml down`. Your data stays in the
  `vita-prod_db-data` volume.

## First login

On its first start, Vita creates the admin user from `VITA_ADMIN_USERNAME` and
`VITA_ADMIN_PASSWORD`. Open the app and log in with them.

- **Changing the password.** Click your user name (top right), then **Change password**.
  This logs out your other sessions.
- **Changing `VITA_ADMIN_PASSWORD` later has no effect** once the user exists, so a password
  changed in the app survives restarts.
- **Forgotten password.** Set a new one from the command line:
  ```sh
  docker compose exec backend python -m app.reset_password                                  # dev
  docker compose -f docker-compose.prod.yml exec backend python -m app.reset_password       # prod
  ```
- **Failed logins.** After 5 failed attempts for the same user from the same address, login
  is paused for 30 seconds. The pause doubles with each further failure, up to 15 minutes.
- **Sessions.** A login lasts `VITA_SESSION_DAYS` (7 days by default). **Log out** is in
  the same user menu.

## Build your first dashboard

This walkthrough uses the demo database. It's included in the development stack, and in
production with `--profile demo`. It has a `sales` schema with about 800 orders over two
years.

1. **Connect the demo database.** Go to **Connections → Add connection** and enter:

   | Field | Value |
   |---|---|
   | Name | `Sample DB` |
   | Type | PostgreSQL |
   | Host / Port | `sampledb` / `5432` |
   | Database / Username / Password | the `SAMPLEDB_DB`, `SAMPLEDB_USER`, `SAMPLEDB_PASSWORD` values from `.env` |

   Click **Test**, then **Save**.

2. **Explore it (optional).** Open **SQL Lab**, pick `Sample DB`, and run:
   `SELECT * FROM sales.order_totals LIMIT 20`.

3. **Create a dataset.** Go to **Datasets → New dataset**. Choose `Sample DB`, schema
   `sales`, table `order_totals` (a view with one row per order), then **Create dataset**. On the
   dataset page:
   - **Columns:** check that `order_date` is the main time column. It's picked
     automatically.
   - **Metrics → + Add metric:** name `revenue`, label `Revenue`, expression `SUM(total)`,
     format `$0,0.00`. Then **Save**.

4. **Create four charts.** Click **Create chart** on the dataset, set up each chart below,
   and **Save** it under the name shown.

   | Chart type | Settings | Save as |
   |---|---|---|
   | Big number | Metric: Revenue | `Total revenue` |
   | Line | Metric: Revenue · time grain: Month | `Revenue by month` |
   | Bar | Metric: Revenue · X axis: `channel` | `Revenue by channel` |
   | Table | Group by: `status` · metrics: Count, Revenue | `Orders by status` |

5. **Build the dashboard.**
   1. Go to **Dashboards → New dashboard** and name it `Sales overview`. It opens in edit
      mode.
   2. Click **Add text** and type `# Sales overview`.
   3. Click **Add chart** four times to add the four charts.
   4. Drag tiles by their header and resize them from the corner or edges. A good layout:
      the title across the top, the big number next to the line chart, then the bar chart
      and the table.
   5. Click **Save**.

6. **Use it.** Every chart loads on its own. **Refresh all** reloads everything, and the
   **Auto-refresh** menu reloads every 1 to 60 minutes while the browser tab is visible.
   Each tile's **⋯** menu has Refresh, View SQL, Download CSV and Edit chart.
   You can also add a chart to a dashboard from the chart editor with
   **Add to dashboard**.

## Backups and restore

Back up Vita's metadata database regularly. It holds your connections, saved queries,
datasets, charts, dashboards and the user account.

> **Back up `VITA_SECRET_KEY` (from `.env`) too, and keep it somewhere safe and separate.**
> The backup holds saved connection passwords *encrypted* with this key. If you restore on
> a machine with a different or lost key, those passwords can't be decrypted and must be
> re-entered.

**Make a backup.** It writes a `pg_dump` file named with the date, such as
`backups/vita-20261105-221852.dump`:

```sh
scripts/backup.sh                                  # development stack
scripts/backup.sh -f docker-compose.prod.yml       # production stack
scripts/backup.sh -f docker-compose.prod.yml /path/to/backups   # another folder
```

To make one every night, run it from cron (Linux) or Task Scheduler (Windows, through Git
Bash), for example `0 3 * * * cd /opt/vita && scripts/backup.sh -f docker-compose.prod.yml`.
Copy the files off the machine as well.

**Restore a backup.** This **replaces all current Vita data**:

```sh
scripts/restore.sh backups/vita-20261105-221852.dump                               # development
scripts/restore.sh -f docker-compose.prod.yml backups/vita-20261105-221852.dump    # production
```

The restore script:
1. asks you to type `restore` to confirm (`--yes` skips this)
2. saves a safety backup of the current data to `backups/pre-restore/`
3. stops the backend, replaces the database contents, and starts the backend again (which
   runs any newer migrations)

You can restore into a fresh install: create `.env` with the **same `VITA_SECRET_KEY`**,
then run the restore script.

## Connecting to your own databases
The backend runs inside Docker, so `localhost` there means the backend container itself.
For a database on the machine running Docker, use the host **`host.docker.internal`**.

> **Use a read-only database user for your connections.** Vita only runs read queries
> inside read-only transactions. But the database's own permissions are the real
> protection: for example, a function can have side effects.

Query limits:
- one statement per run
- read queries only (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN)
- up to 1,000 rows by default (10,000 at most)
- 30 seconds per query

## SQL Lab keyboard shortcuts

| Action | How |
|---|---|
| Run the query (or only the selected text) | **Ctrl+Enter** (Cmd+Enter on Mac) |
| Save the tab as a saved query | **Ctrl+S** |
| Autocomplete | type, or **Ctrl+Space**; after `alias.` you get that table's columns |
| Insert a table or column name | click it in the Schema panel |
| Copy a cell value | click the cell, then **Ctrl+C** |

## Development: tests, lint, migrations

```sh
# Backend
docker compose exec backend pytest            # tests (use a separate vita_test database)
docker compose exec backend ruff check .      # lint
docker compose exec backend ruff format .     # format
docker compose exec backend mypy .            # type check (strict)

# Frontend
docker compose exec frontend npm test         # Vitest
docker compose exec frontend npm run lint     # ESLint
docker compose exec frontend npm run typecheck

# Database migrations
docker compose exec backend alembic revision --autogenerate -m "describe change"
docker compose exec backend alembic upgrade head
```

After adding frontend dependencies, rebuild with `docker compose up -d --build -V frontend`.
`-V` recreates the `node_modules` volume.

The demo database is seeded only when its volume is first created. To re-seed it:

```sh
docker compose rm -sf sampledb
docker volume rm vitaproject_sampledb-data
docker compose up -d sampledb
```

### Layout
```
backend/                 FastAPI app (app/), Alembic migrations, pytest tests
frontend/                React + TypeScript + Vite; Dockerfile.prod + nginx.conf for production
sampledb/                seed SQL for the demo database
scripts/                 backup.sh, restore.sh
docker-compose.yml       development
docker-compose.prod.yml  production
```
