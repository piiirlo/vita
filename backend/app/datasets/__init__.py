"""Datasets: a table or a SQL query plus column metadata and metrics.

Everything here is independent of FastAPI so the chart builder (Part 6) can reuse it:
- sql.py:    FROM clause / SELECT generation with sqlglot (correct quoting per dialect)
- checks.py: safety checks for SQL datasets and metric expressions (no database needed)
- sync.py:   read columns from the user database and merge them into a dataset
- run.py:    preview and metric validation through run_query
"""

from app.datasets.checks import check_dataset_sql, metric_warning, parse_metric_expression
from app.datasets.run import preview, validate_metric
from app.datasets.sql import (
    DatasetSource,
    column,
    from_clause,
    select_sql,
    source_of,
    sqllab_sql,
)
from app.datasets.sync import DetectedColumn, SyncResult, detect_columns, merge_columns

__all__ = [
    "DatasetSource",
    "DetectedColumn",
    "SyncResult",
    "check_dataset_sql",
    "column",
    "detect_columns",
    "from_clause",
    "merge_columns",
    "metric_warning",
    "parse_metric_expression",
    "preview",
    "select_sql",
    "source_of",
    "sqllab_sql",
    "validate_metric",
]
