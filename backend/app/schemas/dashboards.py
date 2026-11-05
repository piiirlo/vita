"""Dashboard schemas: a layout is a list of chart and text tiles on a 12-column grid."""

from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.charts import VizType

GRID_COLUMNS = 12
MAX_TILE_HEIGHT = 100
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


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    layout: list[Tile] = Field(default_factory=list, max_length=MAX_TILES)
    refresh_interval: RefreshInterval = "off"

    @model_validator(mode="after")
    def _check_layout(self) -> Self:
        _unique_tile_ids(self.layout)
        return self


class AddChartIn(BaseModel):
    chart_id: int


class DashboardChartInfo(BaseModel):
    id: int
    name: str
    viz_type: VizType


class DashboardListItem(BaseModel):
    id: int
    name: str
    description: str | None
    chart_count: int
    created_at: datetime
    updated_at: datetime


class DashboardOut(BaseModel):
    id: int
    name: str
    description: str | None
    layout: list[Tile]
    refresh_interval: RefreshInterval
    # Basic info of every chart in the layout, keyed by chart id (JSON keys are strings).
    charts: dict[int, DashboardChartInfo]
    created_at: datetime
    updated_at: datetime
