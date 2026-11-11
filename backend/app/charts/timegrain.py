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
    "quarter": (
        f"MAKEDATE(YEAR({_PLACEHOLDER}), 1) + INTERVAL (QUARTER({_PLACEHOLDER}) - 1) QUARTER"
    ),
    "year": f"MAKEDATE(YEAR({_PLACEHOLDER}), 1)",
}


def time_bucket(column: exp.Expr, grain: Grain, db_type: str) -> exp.Expr:
    """The start of the grain bucket that `column` falls in, as a DATE."""
    if db_type == "postgresql":
        trunc = exp.Anonymous(
            this="DATE_TRUNC", expressions=[exp.Literal.string(grain), column.copy()]
        )
        return exp.cast(trunc, exp.DataType.build("DATE"))
    if db_type == "mysql":
        template = sqlglot.parse_one(_MYSQL_TEMPLATES[grain], read="mysql")
        return template.transform(
            lambda node: (
                column.copy()
                if isinstance(node, exp.Column) and node.name == _PLACEHOLDER
                else node
            )
        )
    raise ValueError(f"Unsupported database type: {db_type}")


# Parts of a date / time as a dimension (heatmaps: weekday x hour...). Always an integer:
# day_of_week 1 = Monday ... 7 = Sunday on both databases, hour_of_day 0-23, month_of_year 1-12.
TIME_PARTS = ("day_of_week", "hour_of_day", "month_of_year")


def time_part(column: exp.Expr, part: str, db_type: str) -> exp.Expr:
    """An integer part of `column` (see TIME_PARTS)."""
    if db_type == "postgresql":
        field = {"day_of_week": "ISODOW", "hour_of_day": "HOUR", "month_of_year": "MONTH"}[part]
        extract = exp.Extract(this=exp.Var(this=field), expression=column.copy())
        return exp.cast(extract, exp.DataType.build("INT"))
    if db_type == "mysql":
        if part == "day_of_week":
            # WEEKDAY(): Monday = 0 ... Sunday = 6 (DAYOFWEEK would start on Sunday).
            weekday = exp.Anonymous(this="WEEKDAY", expressions=[column.copy()])
            return exp.Paren(this=exp.Add(this=weekday, expression=exp.Literal.number(1)))
        name = {"hour_of_day": "HOUR", "month_of_year": "MONTH"}[part]
        return exp.Anonymous(this=name, expressions=[column.copy()])
    raise ValueError(f"Unsupported database type: {db_type}")
