"""Time grain expressions per dialect. The bucket is always a DATE (every grain is >= a day).

Postgres: CAST(DATE_TRUNC('<grain>', col) AS DATE). The cast matters: date_trunc on a DATE
column returns timestamptz, which depends on the session time zone. Postgres weeks start
on Monday.

MySQL has no date_trunc; these are fixed templates (adapted from Superset's MySQL engine
spec, with weeks starting on Monday). Only the column's AST node is substituted in.
"""

import sqlglot
from sqlglot import exp

from app.schemas.charts import Grain

_PLACEHOLDER = "__vita_col__"

_MYSQL_TEMPLATES: dict[str, str] = {
    "day": f"DATE({_PLACEHOLDER})",
    # WEEKDAY(): Monday = 0 ... Sunday = 6
    "week": f"DATE(DATE_SUB({_PLACEHOLDER}, INTERVAL WEEKDAY({_PLACEHOLDER}) DAY))",
    "month": f"DATE(DATE_SUB({_PLACEHOLDER}, INTERVAL DAYOFMONTH({_PLACEHOLDER}) - 1 DAY))",
    "quarter": f"MAKEDATE(YEAR({_PLACEHOLDER}), 1) + INTERVAL (QUARTER({_PLACEHOLDER}) - 1) QUARTER",
    "year": f"MAKEDATE(YEAR({_PLACEHOLDER}), 1)",
}


def time_bucket(column: exp.Expression, grain: Grain, db_type: str) -> exp.Expression:
    """The start of the grain bucket that `column` falls in, as a DATE."""
    if db_type == "postgresql":
        trunc = exp.Anonymous(this="DATE_TRUNC", expressions=[exp.Literal.string(grain), column.copy()])
        return exp.cast(trunc, exp.DataType.build("DATE"))
    if db_type == "mysql":
        template = sqlglot.parse_one(_MYSQL_TEMPLATES[grain], read="mysql")
        return template.transform(
            lambda node: column.copy()
            if isinstance(node, exp.Column) and node.name == _PLACEHOLDER
            else node
        )
    raise ValueError(f"Unsupported database type: {db_type}")
