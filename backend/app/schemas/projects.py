from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=5000)


class SetupDraftIn(BaseModel):
    # What the wizard needs to resume (step, source, table, marks, SQL...). Never secrets.
    draft: dict[str, Any]


class ProjectDashboard(BaseModel):
    id: int
    name: str
    chart_count: int


class ProjectOut(BaseModel):
    id: int
    name: str
    description: str | None
    dashboard_count: int
    dataset_count: int
    chart_count: int
    connection_count: int
    saved_query_count: int
    # Where its data comes from: a connected database, an uploaded file, or both.
    sources: list[Literal["database", "file"]]
    # The most recently changed dashboards (at most 3: the papers in the folder).
    dashboards: list[ProjectDashboard]
    # The unfinished setup wizard (None = none).
    setup_draft: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
