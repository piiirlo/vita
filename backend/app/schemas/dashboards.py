"""Dashboard schemas: a layout is a list of chart and text tiles on a 24-column grid."""

from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.dashboard_grid import GRID_COLUMNS
from app.schemas.charts import MAX_CACHE_TTL, DashboardFilterKind, FilterSelection, VizType

MAX_TILE_HEIGHT = 200
MAX_TILES = 100
MAX_TEXT_LENGTH = 10_000

RefreshInterval = Literal["off", "1m", "5m", "15m", "1h"]


class _TileBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    x: int = Field(ge=0, lt=GRID_COLUMNS)
    y: int = Field(ge=0)
    w: int = Field(ge=1, le=GRID_COLUMNS)
    h: int = Field(ge=1, le=MAX_TILE_HEIGHT)

    @model_validator(mode="after")
    def _fits(self) -> Self:
        if self.x + self.w > GRID_COLUMNS:
            raise ValueError(f"Tile {self.id} is wider than the {GRID_COLUMNS}-column grid")
        return self


class ChartTile(_TileBase):
    type: Literal["chart"]
    chart_id: int


class TextTile(_TileBase):
    type: Literal["text"]
    text: str = Field(default="", max_length=MAX_TEXT_LENGTH)  # markdown


Tile = Annotated[ChartTile | TextTile, Field(discriminator="type")]


def _unique_tile_ids(layout: list[ChartTile | TextTile]) -> None:
    seen: set[str] = set()
    for tile in layout:
        if tile.id in seen:
            raise ValueError(f'Duplicate tile id "{tile.id}"')
        seen.add(tile.id)


MAX_FILTERS = 20


class DashboardFilterDef(BaseModel):
    """A filter in the dashboard's filter bar. By default it targets every chart whose dataset
    has a column named `column` (time: every chart with a time column); `targets` = an
    explicit list of chart ids instead."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    kind: DashboardFilterKind
    label: str = Field(default="", max_length=100)
    # The column (by name) for values / range filters.
    column: str | None = Field(default=None, max_length=255)
    # Where a values filter reads its choices from (SELECT DISTINCT column).
    dataset_id: int | None = None
    targets: list[int] | None = Field(default=None, max_length=MAX_TILES)
    default: FilterSelection = Field(default_factory=FilterSelection)
    # Values filters: other filters (ids) whose current values limit the choices, e.g. City
    # only offers the cities of the chosen Country.
    depends_on: list[str] = Field(default_factory=list, max_length=MAX_FILTERS)

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.kind != "time" and not self.column:
            raise ValueError(f"The {self.kind} filter needs a column")
        if self.kind == "values" and self.dataset_id is None:
            raise ValueError("A values filter needs a dataset to read its values from")
        if self.depends_on and self.kind != "values":
            raise ValueError("Only values filters can depend on other filters")
        if self.id in self.depends_on:
            raise ValueError("A filter can't depend on itself")
        return self


def _check_filters(filters: list[DashboardFilterDef]) -> None:
    ids = [f.id for f in filters]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate filter id")
    for f in filters:
        unknown = [d for d in f.depends_on if d not in ids]
        if unknown:
            raise ValueError(f"Filter {f.id} depends on unknown filters: {', '.join(unknown)}")


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    layout: list[Tile] = Field(default_factory=list, max_length=MAX_TILES)
    refresh_interval: RefreshInterval = "off"
    # None = the default project. Its tiles show only charts of its own project (ignored on
    # update: a dashboard never moves to another project).
    project_id: int | None = None
    # Cache lifetime for every tile, in seconds (0 = off); None = each chart's own.
    cache_ttl: int | None = Field(default=None, ge=0, le=MAX_CACHE_TTL)
    # The filter bar (Part 15). Left out by older clients: the saved filters are kept.
    filters: list[DashboardFilterDef] | None = Field(default=None, max_length=MAX_FILTERS)
    # Clicking a bar, slice, row... filters the other charts. None = unchanged.
    cross_filtering: bool | None = None

    @model_validator(mode="after")
    def _check_layout(self) -> Self:
        _unique_tile_ids(self.layout)
        if self.filters:
            _check_filters(self.filters)
        return self


class AddChartIn(BaseModel):
    chart_id: int


class DashboardChartInfo(BaseModel):
    id: int
    name: str
    viz_type: VizType


class DashboardListItem(BaseModel):
    id: int
    project_id: int
    name: str
    description: str | None
    chart_count: int
    created_at: datetime
    updated_at: datetime


class DashboardOut(BaseModel):
    id: int
    project_id: int
    name: str
    description: str | None
    layout: list[Tile]
    refresh_interval: RefreshInterval
    cache_ttl: int | None
    filters: list[DashboardFilterDef]
    cross_filtering: bool
    # Basic info of every chart in the layout, keyed by chart id (JSON keys are strings).
    charts: dict[int, DashboardChartInfo]
    created_at: datetime
    updated_at: datetime
