"""The chart query model (shared by every chart type) and the charts CRUD schemas."""

from datetime import date, datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.query import MAX_LIMIT
from app.schemas.query import QueryResultOut

# Longest allowed cache lifetime (a day).
MAX_CACHE_TTL = 86_400

VizType = Literal[
    "table",
    "big_number",
    "bar",
    "line",
    "pie",
    "area",
    "combo",
    "treemap",
    "funnel",
    "gauge",
    "pivot_table",
    "heatmap",
    "scatter",
    "histogram",
    "world_map",
]
Aggregate = Literal["SUM", "AVG", "MIN", "MAX", "COUNT", "COUNT_DISTINCT"]
Grain = Literal["day", "week", "month", "quarter", "year"]
GRAINS: tuple[str, ...] = ("day", "week", "month", "quarter", "year")
# A chart's time axis: a grain bucket, or "raw" = every distinct time value (no bucketing).
AxisGrain = Literal["day", "week", "month", "quarter", "year", "raw"]
RangeKind = Literal[
    "none",
    "last_7_days",
    "last_30_days",
    "last_90_days",
    "last_12_months",
    "this_year",
    "last_year",
    "custom",
]
Operator = Literal[
    "=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL", "LIKE"
]  # fmt: skip
Scalar = str | int | float | bool
# Lists may contain null: IN [x, null] also matches NULLs; NOT IN [x, null] excludes them.
FilterValue = Scalar | list[Scalar | None] | None

DEFAULT_ROW_LIMIT = 1000
DEFAULT_SERIES_LIMIT = 10
# Pivot tables: at most this many row / column dimensions (every total level is a grouping).
MAX_PIVOT_ROW_DIMENSIONS = 3
MAX_PIVOT_COLUMN_DIMENSIONS = 2
# Histograms: bins by number (default) or width.
DEFAULT_BINS = 20
MAX_BINS = 200


class AdhocMetric(BaseModel):
    """A simple metric without SQL, e.g. {"column": "line_total", "aggregate": "SUM"}."""

    column: str = Field(min_length=1)
    aggregate: Aggregate
    # Output column name; defaults to e.g. "SUM(line_total)".
    label: str | None = Field(default=None, max_length=255)

    @property
    def name(self) -> str:
        return self.label or f"{self.aggregate}({self.column})"


class SqlMetric(BaseModel):
    """A custom SQL metric written in the chart editor, e.g.
    {"sql": "SUM(amount) / NULLIF(SUM(quantity), 0)", "label": "Price per unit"}. The same
    checks as a saved metric's expression (one expression, no clauses, no writes)."""

    model_config = ConfigDict(extra="forbid")

    sql: str = Field(min_length=1, max_length=10_000)
    label: str = Field(min_length=1, max_length=255)
    # numeral.js-style, like a saved metric's (the frontend formats with it).
    number_format: str | None = Field(default=None, max_length=50)

    @property
    def name(self) -> str:
        return self.label


# A saved metric of the dataset (by name), an ad-hoc one or a custom SQL one.
MetricRef = str | AdhocMetric | SqlMetric


class TimeRange(BaseModel):
    kind: RangeKind = "none"
    # Only for kind="custom"; both inclusive, either may be left open.
    start: date | None = None
    end: date | None = None

    @model_validator(mode="after")
    def _custom(self) -> Self:
        if self.kind == "custom":
            if self.start is None and self.end is None:
                raise ValueError("A custom time range needs a start or an end date")
            if self.start and self.end and self.start > self.end:
                raise ValueError("The time range starts after it ends")
        elif self.start is not None or self.end is not None:
            raise ValueError("start and end are only used with a custom time range")
        return self


class TimeSpec(BaseModel):
    # Defaults to the dataset's main time column.
    column: str | None = None
    grain: AxisGrain | None = None
    range: TimeRange = Field(default_factory=TimeRange)


class Filter(BaseModel):
    column: str = Field(min_length=1)
    operator: Operator
    # IN / NOT IN: a list; BETWEEN: [low, high]; IS (NOT) NULL: nothing; others: one value.
    value: FilterValue = None


class BinSpec(BaseModel):
    """Histogram bins of one number column: `count` bins between its MIN and MAX, or bins
    of a fixed `width` (aligned to multiples of it). Width wins when both are set."""

    column: str = Field(min_length=1)
    count: int | None = Field(default=DEFAULT_BINS, ge=1, le=MAX_BINS)
    width: float | None = Field(default=None, gt=0)


class OrderBy(BaseModel):
    # A metric name, a dimension / series / raw column, or the time column.
    by: str = Field(min_length=1)
    descending: bool = True


class ChartQuery(BaseModel):
    dataset_id: int
    metrics: list[MetricRef] = Field(default_factory=list)
    # Most charts: the grouping dimensions. Treemap: the levels (outer first). Pivot: the rows.
    dimensions: list[str] = Field(default_factory=list)
    # Pivot table: the dimensions across (columns).
    column_dimensions: list[str] = Field(default_factory=list)
    # Pivot table: also compute every subtotal and total level (in SQL, so AVG / COUNT
    # DISTINCT totals are right).
    totals: bool = False
    # Bar / line / area: the dimension that splits the chart into series.
    series: str | None = None
    # Histogram: the number column and its bins.
    bins: BinSpec | None = None
    # Table "raw records" mode: these columns, no grouping (metrics must be empty).
    columns: list[str] = Field(default_factory=list)
    time: TimeSpec | None = None
    filters: list[Filter] = Field(default_factory=list)
    order_by: OrderBy | None = None
    row_limit: int = Field(default=DEFAULT_ROW_LIMIT, ge=1, le=MAX_LIMIT)
    # Bar / line / area with a series: keep only the top N series by the first metric.
    # Pie / treemap: the top N slices (outer level), the rest is "Other".
    series_limit: int | None = Field(default=DEFAULT_SERIES_LIMIT, ge=1, le=1000)


class ChartDataRequest(BaseModel):
    viz_type: VizType
    query: ChartQuery
    # Cache lifetime in seconds (0 = don't cache); None = the default (10 minutes).
    cache_ttl: int | None = Field(default=None, ge=0, le=MAX_CACHE_TTL)
    # "Refresh": skip the cache (and store the fresh result).
    refresh: bool = False


class ChartDataOut(QueryResultOut):
    sql: str  # the exact SQL that ran ("View SQL")
    # The time range the query filtered on, both days inclusive (None = open on that side or
    # no time range), so "No data between X and Y" can name it.
    range_start: date | None = None
    range_end: date | None = None
    # Set when the result came from the cache: when it was computed.
    cached_at: datetime | None = None


# ---------- saved charts ----------


class ChartParams(BaseModel):
    """What a chart stores: the query plus display options for the frontend."""

    model_config = ConfigDict(extra="forbid")

    query: ChartQuery
    display: dict[str, Any] = Field(default_factory=dict)


class ChartIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    viz_type: VizType
    params: ChartParams  # params.query.dataset_id is the chart's dataset


class ChartDashboardRef(BaseModel):
    id: int
    name: str


class ChartOut(BaseModel):
    id: int
    name: str
    description: str | None
    dataset_id: int
    dataset_name: str
    viz_type: VizType
    params: ChartParams
    created_at: datetime
    updated_at: datetime
    # The dashboards showing this chart (single-chart responses only; lists leave it empty).
    dashboards: list[ChartDashboardRef] = Field(default_factory=list)
