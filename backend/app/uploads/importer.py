"""Importing an uploaded file into the Uploads database, then the dataset on it.

Modes: create (a new table + a new dataset), replace (a new table swapped in for the old one
under the same name, in one transaction: charts and metrics keep working) and append (rows
added to the existing table). Writes go through the writer role's own psycopg connection
(CREATE TABLE + COPY FROM STDIN), never through run_query. Every name is a psycopg
sql.Identifier. Each import is one transaction: a failed or stopped one leaves nothing.
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.datasets import COUNT_METRIC
from app.datasets.sql import DatasetSource
from app.datasets.sync import detect_columns, detect_number_stats, merge_columns
from app.engines import details_from_connection
from app.models import Connection, Dataset, DatasetMetric, Upload
from app.schemas.uploads import ColumnOption, ImportIn
from app.uploads import bootstrap, files
from app.uploads.names import table_name_for
from app.uploads.preview import FileKind, Target, build_preview, number_format, open_source
from app.uploads.reading import ReadError
from app.uploads.types import NULL_WORDS, PG_TYPES, ColumnType, ConvertError, convert

log = logging.getLogger(__name__)

PROGRESS_EVERY_SECONDS = 1.0
BAD_EXAMPLES = 5

# Postgres types of an uploaded table -> upload column types (for replace / append).
_FROM_PG: dict[str, ColumnType] = {
    "text": "text",
    "character varying": "text",
    "character": "text",
    "bigint": "integer",
    "integer": "integer",
    "smallint": "integer",
    "numeric": "decimal",
    "double precision": "decimal",
    "real": "decimal",
    "date": "date",
    "timestamp without time zone": "datetime",
    "timestamp with time zone": "datetime",
    "boolean": "boolean",
}


class ImportStopped(Exception):
    """The import can't go on (the message is for the user)."""


def table_columns(table: str) -> Target:
    """The columns of an uploaded table, in order (types mapped to upload types)."""
    with psycopg.connect(bootstrap.writer_conninfo()) as conn:
        rows = conn.execute(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
            (bootstrap.SCHEMA, table),
        ).fetchall()
    return [(str(name), _FROM_PG.get(str(data_type), "text")) for name, data_type in rows]


def _free_table_name(conn: psycopg.Connection[Any], wanted: str) -> str:
    taken = {
        r[0]
        for r in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = %s", (bootstrap.SCHEMA,)
        )
    }
    name, n = wanted, 2
    while name in taken:
        name = f"{wanted}_{n}"
        n += 1
    return name


def _kept_columns(columns: list[ColumnOption]) -> list[ColumnOption]:
    kept = [c for c in columns if not c.ignore]
    names = [c.name.strip() for c in kept]
    if len({n.lower() for n in names}) != len(names):
        raise ImportStopped("Two columns have the same name. Rename one of them.")
    return kept


@dataclass
class Job:
    upload_id: int
    path: Path
    kind: FileKind
    mode: str
    file_name: str
    target_dataset_id: int | None
    target_table: str | None


def run_import(upload_id: int, payload: ImportIn, session_factory: sessionmaker[Session]) -> None:
    """The import job (a background task). Records progress and the outcome on the upload."""
    with session_factory() as db:
        upload = db.get(Upload, upload_id)
        if upload is None:
            return
        target = db.get(Dataset, upload.dataset_id) if upload.dataset_id else None
        job = Job(
            upload_id=upload_id,
            path=files.path_for(upload.token),
            kind="xlsx" if upload.file_kind == "xlsx" else "csv",
            mode=upload.mode,
            file_name=upload.file_name,
            target_dataset_id=target.id if target else None,
            target_table=target.table_name if target else None,
        )
        token = upload.token

    def update(**fields: Any) -> None:
        with session_factory() as db:
            row = db.get(Upload, upload_id)
            if row is None:
                return
            for key, value in fields.items():
                setattr(row, key, value)
            db.commit()

    try:
        table, kept, rows = _load(job, payload, update)
        if job.mode == "create":
            dataset_id = _create_dataset(session_factory, payload.dataset_name.strip(), table, kept)
        else:
            assert job.target_dataset_id is not None
            dataset_id = _refresh_dataset(session_factory, job.target_dataset_id)
        update(status="done", progress=1.0, dataset_id=dataset_id, finished_at=datetime.now(UTC))
        log.info("Upload %s: %s rows (%s) into uploads.%s", upload_id, rows, job.mode, table)
    except (ImportStopped, ReadError) as exc:
        update(status="failed", error=str(exc), finished_at=datetime.now(UTC))
    except Exception as exc:
        log.exception("Upload %s failed", upload_id)
        update(status="failed", error=_friendly(exc), finished_at=datetime.now(UTC))
    finally:
        files.delete_file(token)


def _friendly(exc: Exception) -> str:
    if isinstance(exc, psycopg.Error):
        diag = getattr(exc, "diag", None)
        primary = getattr(diag, "message_primary", None)
        return f"The database refused the import: {primary or exc}"
    return f"The import failed: {exc}"


def _load(
    job: Job, payload: ImportIn, update: Callable[..., None]
) -> tuple[str, list[ColumnOption], int]:
    """Create / replace / append the table. Returns (table, kept columns, rows imported)."""
    if not job.path.exists():
        raise ImportStopped("The uploaded file is gone (it's kept for an hour). Upload it again.")
    options = payload.options
    target = table_columns(job.target_table) if job.target_table else None
    if job.target_table and not target:
        raise ImportStopped(f'The table "{job.target_table}" of this dataset no longer exists.')
    preview = build_preview(job.path, options, job.kind, target, job.mode)  # type: ignore[arg-type]
    blocking = [p.message for p in preview.problems if p.blocking]
    if blocking:
        raise ImportStopped(" ".join(blocking))
    kept = _kept_columns(preview.options.columns or [])
    if not kept:
        raise ImportStopped("Every column is left out.")
    fmt = number_format(options)
    max_rows = settings.vita_upload_max_rows

    with psycopg.connect(bootstrap.writer_conninfo()) as conn:
        if job.mode == "append":
            assert job.target_table is not None
            table = job.target_table
            load_into = table
        else:
            table = job.target_table or _free_table_name(conn, table_name_for(job.file_name))
            # Replace: fill a new table, then swap it in for the old one (same transaction).
            load_into = _free_table_name(conn, f"{table}__new") if job.mode == "replace" else table
            conn.execute(
                sql.SQL("CREATE TABLE {} ({})").format(
                    sql.Identifier(bootstrap.SCHEMA, load_into),
                    sql.SQL(", ").join(
                        sql.SQL("{} {}").format(
                            sql.Identifier(c.name.strip()), sql.SQL(PG_TYPES[c.type])
                        )
                        for c in kept
                    ),
                )
            )
        update(table_schema=bootstrap.SCHEMA, table_name=table)
        bad: dict[int, dict[str, Any]] = {}
        null_words: dict[int, dict[str, Any]] = {}
        rows_done = 0
        last_report = time.monotonic()
        target_sql = sql.Identifier(bootstrap.SCHEMA, load_into)
        copy_sql = sql.SQL("COPY {} ({}) FROM STDIN").format(
            target_sql, sql.SQL(", ").join(sql.Identifier(c.name.strip()) for c in kept)
        )
        with open_source(job.path, job.kind, options) as (source, progress):
            with conn.cursor().copy(copy_sql) as copy:
                for row in source.rows:
                    rows_done += 1
                    if rows_done > max_rows:
                        raise ImportStopped(
                            f"The file has more than {max_rows:,} rows, "
                            "the most one upload can have."
                        )
                    values: list[object] = []
                    for c in kept:
                        text = row[c.index]
                        if c.type != "text" and text and text.strip().lower() in NULL_WORDS:
                            entry = null_words.setdefault(
                                c.index,
                                {"column": c.name, "count": 0, "examples": [], "kind": "null_word"},
                            )
                            entry["count"] += 1
                            if len(entry["examples"]) < BAD_EXAMPLES:
                                entry["examples"].append({"row": rows_done, "value": text[:80]})
                        try:
                            value = convert(text, c.type, fmt, c.date_order)
                        except ConvertError:
                            if payload.on_error == "stop":
                                raise ImportStopped(
                                    f'Row {rows_done}, column "{c.name}": "{text[:80]}" isn\'t '
                                    f"a valid {c.type}. Nothing was imported."
                                ) from None
                            entry = bad.setdefault(
                                c.index, {"column": c.name, "count": 0, "examples": []}
                            )
                            entry["count"] += 1
                            if len(entry["examples"]) < BAD_EXAMPLES:
                                entry["examples"].append({"row": rows_done, "value": text[:80]})
                            value = None
                        if isinstance(value, str):
                            value = value.replace("\x00", "")  # Postgres text can't hold NUL
                        values.append(value)
                    copy.write_row(values)
                    now = time.monotonic()
                    if now - last_report >= PROGRESS_EVERY_SECONDS:
                        last_report = now
                        update(progress=min(progress(), 0.99), rows_done=rows_done)
            ragged = len(source.ragged)
        if job.mode == "replace":
            conn.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(bootstrap.SCHEMA, table)))
            conn.execute(
                sql.SQL("ALTER TABLE {} RENAME TO {}").format(
                    sql.Identifier(bootstrap.SCHEMA, load_into), sql.Identifier(table)
                )
            )
        conn.commit()
    warnings = []
    if ragged:
        warnings.append(f"{ragged:,} rows had a different number of cells than the header.")
    update(
        rows_done=rows_done,
        row_count=rows_done,
        progress=0.99,
        bad_values=[*bad.values(), *null_words.values()],
        warnings=warnings,
        columns=[{"name": c.name, "type": c.type, "source": c.index} for c in kept],
    )
    return table, kept, rows_done


def drop_table(table: str) -> None:
    """Drop an uploaded table (writer role). Raises psycopg.Error."""
    with psycopg.connect(bootstrap.writer_conninfo()) as conn:
        conn.execute(
            sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(bootstrap.SCHEMA, table))
        )


def _uploads_connection(db: Session) -> Connection:
    conn = db.scalar(select(Connection).where(Connection.builtin == bootstrap.BUILTIN))
    if conn is None:
        raise ImportStopped("The Uploads connection is missing; restart Vita.")
    return conn


def _create_dataset(
    session_factory: sessionmaker[Session], name: str, table: str, kept: list[ColumnOption]
) -> int:
    """A table dataset on the new table: columns synced, the first date column as time."""
    try:
        with session_factory() as db:
            conn = _uploads_connection(db)
            details = details_from_connection(conn)
            source = DatasetSource("table", schema=bootstrap.SCHEMA, table_name=table)
            detected = detect_columns(details, source)
            stats = detect_number_stats(details, source, detected)
            dataset = Dataset(
                name=name,
                connection_id=conn.id,
                kind="table",
                schema=bootstrap.SCHEMA,
                table_name=table,
            )
            merge_columns(dataset, detected, stats)
            # The first date column is the time column, else the first column of years.
            time_columns = [c.name for c in kept if c.type in ("date", "datetime")]
            years = [c.name for c in dataset.columns if c.time_kind == "year_number"]
            if time_columns or years:
                dataset.main_time_column = (time_columns or years)[0]
            dataset.metrics.append(DatasetMetric(**COUNT_METRIC, is_builtin=True))
            db.add(dataset)
            try:
                db.commit()
            except IntegrityError:
                raise ImportStopped(
                    f'A dataset named "{name}" already exists. Pick another name.'
                ) from None
            return dataset.id
    except Exception:
        try:
            drop_table(table)
        except psycopg.Error:
            log.warning("Couldn't drop upload table %s", table, exc_info=True)
        raise


def _refresh_dataset(session_factory: sessionmaker[Session], dataset_id: int) -> int:
    """After replace / append: sync the columns (labels, metrics, settings are kept; new
    columns are added) and mark the Uploads connection changed, so no chart is served a
    cached result of the old data (the cache key includes the connection's last change)."""
    with session_factory() as db:
        dataset = db.get(Dataset, dataset_id)
        if dataset is None:
            raise ImportStopped("The dataset was deleted during the import.")
        conn = _uploads_connection(db)
        detected = detect_columns(details_from_connection(conn), DatasetSource(
            "table", schema=dataset.schema, table_name=dataset.table_name))  # fmt: skip
        merge_columns(dataset, detected)
        dataset.updated_at = func.now()
        conn.updated_at = func.now()
        db.commit()
        return dataset.id
