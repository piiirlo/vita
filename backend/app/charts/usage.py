"""Which dataset columns and metrics a chart query uses (to block breaking changes)."""

from collections.abc import Iterable
from dataclasses import dataclass, field

from app.schemas.charts import AdhocMetric, ChartQuery

# Roles a column can play; they decide which dataset changes break a chart.
GROUP = "group"  # dimension or series: needs is_dimension or is_temporal
TIME = "time"  # time column: needs is_temporal
OTHER = "other"  # raw column, filter, ad-hoc metric


@dataclass
class QueryUsage:
    columns: dict[str, set[str]] = field(default_factory=dict)  # column -> roles
    metrics: set[str] = field(default_factory=set)  # saved metric names

    def add(self, column: str, role: str) -> None:
        self.columns.setdefault(column, set()).add(role)


def query_usage(query: ChartQuery, main_time_column: str | None) -> QueryUsage:
    usage = QueryUsage()
    for name in query.dimensions:
        usage.add(name, GROUP)
    if query.series:
        usage.add(query.series, GROUP)
    for name in query.columns:
        usage.add(name, OTHER)
    for f in query.filters:
        usage.add(f.column, OTHER)
    for ref in query.metrics:
        if isinstance(ref, AdhocMetric):
            usage.add(ref.column, OTHER)
        else:
            usage.metrics.add(ref)
    time = query.time
    if time is not None and (time.grain is not None or time.range.kind != "none"):
        column = time.column or main_time_column
        if column:
            usage.add(column, TIME)
    return usage


def used_by_message(what: str, chart_names: Iterable[str]) -> str:
    """'Metric "revenue" is used by 2 charts: A, B. Remove it from those charts first.'"""
    names = sorted(chart_names)
    noun = "chart" if len(names) == 1 else "charts"
    return (
        f"{what} is used by {len(names)} {noun}: {', '.join(names)}. "
        "Remove it from those charts first."
    )
