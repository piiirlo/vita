"""Read a dataset's columns from the user database and merge them into the dataset.

Generic types always come from the cursor metadata of `SELECT * FROM <dataset> LIMIT 0`
(the same mapping as SQL Lab), never from row values, so an empty table or a query that
returns no rows still gets correct types. For tables, the inspector adds the nicer
declared types (VARCHAR(100), NUMERIC(10, 2), ...).
"""

import logging
import re
from collections import Counter
from dataclasses import dataclass, field

from app.browsing import read_columns
from app.datasets.sql import DatasetSource, select_sql
from app.datasets.timecols import NumberStats, is_identifier_name, is_year_name, number_stats
from app.engines import ConnectionDetails, create_engine_for
from app.models import Dataset, DatasetColumn
from app.query import DEFAULT_TIMEOUT_SECONDS, QueryError, run_query

log = logging.getLogger(__name__)

TEMPORAL_TYPES = {"date", "datetime"}
# MySQL reports BLOB and TEXT with the same cursor type code; the declared type tells them apart.
_BINARY_TYPE = re.compile(r"BLOB|BINARY|BYTEA", re.IGNORECASE)


@dataclass(frozen=True)
class DetectedColumn:
    name: str
    raw_type: str
    generic_type: str


@dataclass
class SyncResult:
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)  # now marked is_missing
    restored: list[str] = field(default_factory=list)  # were missing, found again
    type_changed: list[str] = field(default_factory=list)


def detect_columns(
    details: ConnectionDetails,
    source: DatasetSource,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> list[DetectedColumn]:
    """The dataset's columns as the database reports them. Raises QueryError."""
    sql = select_sql(source, details.db_type, limit=0)
    result = run_query(details, sql, limit=1, timeout_seconds=timeout_seconds)

    duplicates = [name for name, n in Counter(c.name for c in result.columns).items() if n > 1]
    if duplicates:
        names = ", ".join(f'"{name}"' for name in duplicates)
        raise QueryError(
            "invalid",
            f"The query returns more than one column named {names}. "
            "Give each column a unique name with AS.",
        )

    declared: dict[str, str] = {}
    if source.kind == "table" and source.table_name:
        declared = _declared_types(details, source.schema or "", source.table_name)

    detected: list[DetectedColumn] = []
    for col in result.columns:
        raw_type = declared.get(col.name, col.db_type)
        generic: str = col.type
        if generic == "string" and _BINARY_TYPE.search(raw_type):
            generic = "other"
        detected.append(DetectedColumn(col.name, raw_type, generic))
    return detected


def _declared_types(details: ConnectionDetails, schema: str, table: str) -> dict[str, str]:
    """Declared column types from the inspector. Best effort: the cursor types are enough."""
    engine = create_engine_for(details)
    try:
        with engine.connect() as conn:
            return {c.name: c.type for c in read_columns(conn, details.db_type, schema, table)}
    except Exception:
        log.warning("Couldn't read declared types of %s.%s", schema, table, exc_info=True)
        return {}
    finally:
        engine.dispose()


def detect_number_stats(
    details: ConnectionDetails, source: DatasetSource, detected: list[DetectedColumn]
) -> dict[str, NumberStats]:
    """Year detection needs the number columns' values (one aggregate query). Best effort:
    without them, columns are just not detected as years."""
    names = [c.name for c in detected if c.generic_type == "number"]
    try:
        return number_stats(details, source, names)
    except QueryError:
        log.warning("Couldn't read number column stats", exc_info=True)
        return {}


def _time_kind_after_type_change(col: DatasetColumn) -> None:
    """A temporal column whose type changed: dates need no conversion; anything else is
    checked again lazily ("pending")."""
    if not col.is_temporal:
        return
    if col.effective_type in TEMPORAL_TYPES:
        col.time_kind = None
        col.text_date_format = None
    elif col.time_kind is None:
        col.time_kind = "pending"


def merge_columns(
    dataset: Dataset,
    detected: list[DetectedColumn],
    stats: dict[str, NumberStats] | None = None,
) -> SyncResult:
    """Update dataset.columns from what the database reports.

    - new columns are added with guessed settings: dates are temporal; number columns with
      identifier-like names are identifiers; with `stats`, whole numbers all in 1900-2100
      are a year time column when the name says "year", else only suggested
    - existing columns keep the user's settings; only raw/generic type and position change
      (and the "looks like years" suggestion is refreshed)
    - columns that disappeared are marked is_missing (settings kept, in case they return)
    - main_time_column is cleared if its column is gone, and guessed if exactly one
      temporal column exists and none is set (a real date column first)
    """
    stats = stats or {}
    result = SyncResult()
    existing = {c.name: c for c in dataset.columns}
    seen: set[str] = set()

    for position, found in enumerate(detected):
        seen.add(found.name)
        col = existing.get(found.name)
        found_stats = stats.get(found.name)
        years = found_stats is not None and found_stats.auto_years()
        if col is None:
            year_column = years and is_year_name(found.name)
            col = DatasetColumn(
                name=found.name,
                generic_type=found.generic_type,
                is_temporal=found.generic_type in TEMPORAL_TYPES or year_column,
                time_kind="year_number" if year_column else None,
                is_dimension=found.generic_type in {"string", "boolean"},
                is_hidden=False,
                is_missing=False,
                is_identifier=found.generic_type == "number"
                and is_identifier_name(found.name)
                and not year_column,
                looks_like_years=years and not year_column,
            )
            dataset.columns.append(col)
            result.added.append(found.name)
        else:
            if col.is_missing:
                result.restored.append(found.name)
            elif col.generic_type != found.generic_type:
                result.type_changed.append(found.name)
            col.is_missing = False
            if found_stats is not None:
                col.looks_like_years = years and not col.is_temporal
        col.position = position
        col.raw_type = found.raw_type
        changed = col.generic_type != found.generic_type
        col.generic_type = found.generic_type
        if changed:
            _time_kind_after_type_change(col)

    for offset, col in enumerate(c for c in dataset.columns if c.name not in seen):
        if not col.is_missing:
            result.removed.append(col.name)
        col.is_missing = True
        col.position = len(detected) + offset

    temporal = [c for c in dataset.columns if c.is_temporal and not c.is_missing]
    if dataset.main_time_column not in {c.name for c in temporal}:
        dataset.main_time_column = None
    if dataset.main_time_column is None and temporal:
        dates = [c.name for c in temporal if c.time_kind is None]
        if len(dates) == 1:
            dataset.main_time_column = dates[0]
        elif not dates and len(temporal) == 1:
            dataset.main_time_column = temporal[0].name

    dataset.columns.sort(key=lambda c: c.position)
    return result
