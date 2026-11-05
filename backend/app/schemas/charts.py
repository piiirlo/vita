"""The chart query model (shared by every chart type) and the charts CRUD schemas."""

from datetime import date, datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.query import MAX_LIMIT
from app.schemas.query import QueryResultOut

VizType = Literal["table", "big_number", "bar", "line"]
Aggregate = Literal["SUM", "AVG", "MIN", "MAX", "COUNT", "COUNT_DISTINCT"]
Grain = Literal["day", "week", "month", "quarter", "year"]
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


class AdhocMetric(BaseModel):
    """A simple metric without SQL, e.g. {"column": "line_total", "aggregate": "SUM"}."""

    column: str = Field(min_length=1)
    aggregate: Aggregate
    # Output column name; defaults to e.g. "SUM(line_total)".
    label: str | None = Field(default=None, max_length=255)

    @property
    def name(self) -> str:
        return self.label or f"{self.aggregate}({self.column})"


# A saved metric of the dataset (by name) or an ad-hoc one.
MetricRef = str | AdhocMetric


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
    grain: Grain | None = None
    range: TimeRange = Field(default_factory=TimeRange)


class Filter(BaseModel):
    column: str = Field(min_length=1)
    operator: Operator
    # IN / NOT IN: a list; BETWEEN: [low, high]; IS (NOT) NULL: nothing; others: one value.
    value: FilterValue = None


class OrderBy(BaseModel):
    # A metric name, a dimension / series / raw column, or the time column.
    by: str = Field(min_length=1)
    descending: bool = True


class ChartQuery(BaseModel):
    dataset_id: int
    metrics: list[MetricRef] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    # Bar / line: the dimension that splits the chart into series.
    series: str | None = None
    # Table "raw records" mode: these columns, no grouping (metrics must be empty).
    columns: list[str] = Field(default_factory=list)
    time: TimeSpec | None = None
    filters: list[Filter] = Field(default_factory=list)
    order_by: OrderBy | None = None
    row_limit: int = Field(default=DEFAULT_ROW_LIMIT, ge=1, le=MAX_LIMIT)
    # Bar / line with a series: keep only the top N series by the first metric.
    series_limit: int | None = Field(default=DEFAULT_SERIES_LIMIT, ge=1, le=1000)


class ChartDataRequest(BaseModel):
    viz_type: VizType
    query: ChartQuery


class ChartDataOut(QueryResultOut):
    sql: str  # the exact SQL that ran ("View SQL")


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
