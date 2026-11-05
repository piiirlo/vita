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


def merge_columns(dataset: Dataset, detected: list[DetectedColumn]) -> SyncResult:
    """Update dataset.columns from what the database reports.

    - new columns are added with guessed settings
    - existing columns keep the user's settings; only raw/generic type and position change
    - columns that disappeared are marked is_missing (settings kept, in case they return)
    - main_time_column is cleared if its column is gone, and guessed if exactly one
      temporal column exists and none is set
    """
    result = SyncResult()
    existing = {c.name: c for c in dataset.columns}
    seen: set[str] = set()

    for position, found in enumerate(detected):
        seen.add(found.name)
        col = existing.get(found.name)
        if col is None:
            col = DatasetColumn(
                name=found.name,
                generic_type=found.generic_type,
                is_temporal=found.generic_type in TEMPORAL_TYPES,
                is_dimension=found.generic_type in {"string", "boolean"},
                is_hidden=False,
                is_missing=False,
            )
            dataset.columns.append(col)
            result.added.append(found.name)
        else:
            if col.is_missing:
                result.restored.append(found.name)
            elif col.generic_type != found.generic_type:
                result.type_changed.append(found.name)
            col.is_missing = False
        col.position = position
        col.raw_type = found.raw_type
        col.generic_type = found.generic_type

    for offset, col in enumerate(c for c in dataset.columns if c.name not in seen):
        if not col.is_missing:
            result.removed.append(col.name)
        col.is_missing = True
        col.position = len(detected) + offset

    temporal = [c.name for c in dataset.columns if c.is_temporal and not c.is_missing]
    if dataset.main_time_column not in temporal:
        dataset.main_time_column = None
    if dataset.main_time_column is None and len(temporal) == 1:
        dataset.main_time_column = temporal[0]

    dataset.columns.sort(key=lambda c: c.position)
    return result
