"""Query engine: run one read-only SQL query on a saved connection.

Use run_query() from anywhere that needs data from a user database
(API now, chart builder in Part 6).
"""

from app.query.errors import QueryError
from app.query.runner import (
    DEFAULT_LIMIT,
    DEFAULT_TIMEOUT_SECONDS,
    MAX_LIMIT,
    QueryResult,
    ResultColumn,
    run_query,
)

__all__ = [
    "DEFAULT_LIMIT",
    "DEFAULT_TIMEOUT_SECONDS",
    "MAX_LIMIT",
    "QueryError",
    "QueryResult",
    "ResultColumn",
    "run_query",
]
