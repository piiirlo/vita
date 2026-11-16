"""Dashboards CRUD (/api/dashboards). Charts are loaded by the frontend one tile at a time
through /api/charts/{id} and /api/chart-data, so these endpoints never query user databases."""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import Select, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.projects import resolve_project, same_project
from app.dashboard_grid import GRID_COLUMNS, first_free_spot
from app.db import get_db
from app.models import Chart, Dashboard, DashboardChart, Dataset
from app.schemas.dashboards import (
    MAX_TILES,
    AddChartIn,
    ChartTile,
    DashboardChartInfo,
    DashboardFilterDef,
    DashboardIn,
    DashboardListItem,
    DashboardOut,
)

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]

# Size of a chart tile added with "Add to dashboard" (half the grid width).
NEW_CHART_TILE_W = 12  # half the 24-column grid
NEW_CHART_TILE_H = 16


def _get_or_404(db: Session, dashboard_id: int) -> Dashboard:
    dashboard = db.scalar(
        select(Dashboard)
        .where(Dashboard.id == dashboard_id)
        .options(selectinload(Dashboard.chart_links))
    )
    if dashboard is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dashboard not found")
    return dashboard


def _chart_ids(layout: list[dict[str, Any]]) -> list[int]:
    ids: list[int] = []
    for tile in layout:
        if tile.get("type") == "chart" and tile["chart_id"] not in ids:
            ids.append(int(tile["chart_id"]))
    return ids


def _out(db: Session, dashboard: Dashboard) -> DashboardOut:
    ids = _chart_ids(dashboard.layout)
    charts = db.execute(select(Chart.id, Chart.name, Chart.viz_type).where(Chart.id.in_(ids))).all()
    return DashboardOut(
        id=dashboard.id,
        project_id=dashboard.project_id,
        name=dashboard.name,
        description=dashboard.description,
        layout=dashboard.layout,
        refresh_interval=dashboard.refresh_interval,
        cache_ttl=dashboard.cache_ttl,
        filters=dashboard.filters or [],
        cross_filtering=dashboard.cross_filtering,
        charts={
            c.id: DashboardChartInfo(id=c.id, name=c.name, viz_type=c.viz_type) for c in charts
        },
        created_at=dashboard.created_at,
        updated_at=dashboard.updated_at,
    )


def _name_taken(name: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, f'A dashboard named "{name}" already exists')


def _name_stmt(name: str, project_id: int) -> Select[Any]:
    return select(Dashboard.id).where(
        func.lower(Dashboard.name) == name.lower(), Dashboard.project_id == project_id
    )


def _check_name_free(
    db: Session, name: str, project_id: int, dashboard_id: int | None = None
) -> None:
    stmt = _name_stmt(name, project_id)
    if dashboard_id is not None:
        stmt = stmt.where(Dashboard.id != dashboard_id)
    if db.scalar(stmt) is not None:
        raise _name_taken(name)


def _check_charts_exist(db: Session, chart_ids: list[int], project_id: int) -> None:
    rows = db.execute(select(Chart.id, Chart.project_id).where(Chart.id.in_(chart_ids)))
    found = {row.id: row.project_id for row in rows}
    missing = [i for i in chart_ids if i not in found]
    if missing:
        noun = "chart doesn't" if len(missing) == 1 else "charts don't"
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"These {noun} exist (anymore): {', '.join(str(i) for i in missing)}. "
            "Remove those tiles and save again.",
        )
    elsewhere = [i for i in chart_ids if found[i] != project_id]
    if elsewhere:
        noun = "chart belongs" if len(elsewhere) == 1 else "charts belong"
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"These {noun} to another project: {', '.join(str(i) for i in elsewhere)}. "
            "A dashboard shows only its own project's charts.",
        )


def _set_layout(db: Session, dashboard: Dashboard, layout: list[dict[str, Any]]) -> None:
    """Store the layout and sync the dashboard -> charts links with it."""
    chart_ids = _chart_ids(layout)
    _check_charts_exist(db, chart_ids, dashboard.project_id)
    dashboard.layout = layout
    keep = set(chart_ids)
    for link in list(dashboard.chart_links):
        if link.chart_id not in keep:
            dashboard.chart_links.remove(link)
    existing = {link.chart_id for link in dashboard.chart_links}
    for chart_id in chart_ids:
        if chart_id not in existing:
            dashboard.chart_links.append(DashboardChart(chart_id=chart_id))


def _apply(db: Session, dashboard: Dashboard, payload: DashboardIn) -> None:
    name = payload.name.strip()
    if dashboard.project_id is None:
        dashboard.project_id = resolve_project(db, payload.project_id)
    _check_name_free(db, name, dashboard.project_id, dashboard.id)
    dashboard.name = name
    dashboard.description = (payload.description or "").strip() or None
    dashboard.refresh_interval = payload.refresh_interval
    dashboard.cache_ttl = payload.cache_ttl
    _set_layout(db, dashboard, [t.model_dump(mode="json") for t in payload.layout])
    if payload.filters is not None:
        _set_filters(db, dashboard, payload.filters)
    elif dashboard.filters is None:
        dashboard.filters = []
    if payload.cross_filtering is not None:
        dashboard.cross_filtering = payload.cross_filtering
    elif dashboard.cross_filtering is None:
        dashboard.cross_filtering = True


def _set_filters(db: Session, dashboard: Dashboard, filters: list[DashboardFilterDef]) -> None:
    """Values filters read their choices from a dataset of the dashboard's own project."""
    for f in filters:
        if f.dataset_id is None:
            continue
        owner = db.scalar(select(Dataset.project_id).where(Dataset.id == f.dataset_id))
        if owner is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f'The dataset of the filter "{f.label or f.column}" doesn\'t exist (anymore).',
            )
        same_project(
            owner, dashboard.project_id, f'The dataset of the filter "{f.label or f.column}"'
        )
    dashboard.filters = [f.model_dump(mode="json") for f in filters]


def _commit(db: Session, name: str, project_id: int) -> None:
    try:
        db.commit()
    except IntegrityError:
        # A name race, or a chart deleted between the check and the commit.
        db.rollback()
        if db.scalar(_name_stmt(name, project_id)):
            raise _name_taken(name) from None
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A chart on this dashboard was just deleted. Try again."
        ) from None


@router.get("", response_model=list[DashboardListItem])
def list_dashboards(
    db: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    project_id: int | None = None,
) -> list[DashboardListItem]:
    stmt = select(Dashboard)
    if project_id is not None:
        stmt = stmt.where(Dashboard.project_id == project_id)
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(Dashboard.name.ilike(pattern), Dashboard.description.ilike(pattern)))
    stmt = stmt.order_by(Dashboard.updated_at.desc(), Dashboard.id.desc())
    return [
        DashboardListItem(
            id=d.id,
            project_id=d.project_id,
            name=d.name,
            description=d.description,
            chart_count=sum(1 for t in d.layout if t.get("type") == "chart"),
            created_at=d.created_at,
            updated_at=d.updated_at,
        )
        for d in db.scalars(stmt)
    ]


@router.post("", response_model=DashboardOut, status_code=status.HTTP_201_CREATED)
def create_dashboard(payload: DashboardIn, db: DbSession) -> DashboardOut:
    dashboard = Dashboard()
    _apply(db, dashboard, payload)
    db.add(dashboard)
    _commit(db, dashboard.name, dashboard.project_id)
    return _out(db, _get_or_404(db, dashboard.id))


@router.get("/{dashboard_id}", response_model=DashboardOut)
def get_dashboard(dashboard_id: int, db: DbSession) -> DashboardOut:
    return _out(db, _get_or_404(db, dashboard_id))


@router.put("/{dashboard_id}", response_model=DashboardOut)
def update_dashboard(dashboard_id: int, payload: DashboardIn, db: DbSession) -> DashboardOut:
    dashboard = _get_or_404(db, dashboard_id)
    _apply(db, dashboard, payload)
    _commit(db, dashboard.name, dashboard.project_id)
    db.expire_all()
    return _out(db, _get_or_404(db, dashboard_id))


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard(dashboard_id: int, db: DbSession) -> Response:
    db.delete(_get_or_404(db, dashboard_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _copy_name(db: Session, name: str, project_id: int) -> str:
    taken = {
        n.lower()
        for n in db.scalars(select(Dashboard.name).where(Dashboard.project_id == project_id))
    }
    base = f"{name} (copy)"
    candidate, n = base, 2
    while candidate.lower() in taken:
        candidate = f"{name} (copy {n})"
        n += 1
    return candidate[:200]


@router.post(
    "/{dashboard_id}/duplicate", response_model=DashboardOut, status_code=status.HTTP_201_CREATED
)
def duplicate_dashboard(dashboard_id: int, db: DbSession) -> DashboardOut:
    source = _get_or_404(db, dashboard_id)
    copy = Dashboard(
        project_id=source.project_id,
        name=_copy_name(db, source.name, source.project_id),
        description=source.description,
        refresh_interval=source.refresh_interval,
        cache_ttl=source.cache_ttl,
        filters=list(source.filters or []),
        cross_filtering=source.cross_filtering,
    )
    _set_layout(db, copy, [dict(t) for t in source.layout])
    db.add(copy)
    _commit(db, copy.name, copy.project_id)
    return _out(db, _get_or_404(db, copy.id))


@router.post("/{dashboard_id}/charts", response_model=DashboardOut)
def add_chart(dashboard_id: int, payload: AddChartIn, db: DbSession) -> DashboardOut:
    """Add a chart tile in the first free spot (top to bottom, left to right) that fits it:
    "Add to dashboard" and "Save to dashboard" in the chart editor."""
    dashboard = _get_or_404(db, dashboard_id)
    if len(dashboard.layout) >= MAX_TILES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"A dashboard has at most {MAX_TILES} tiles"
        )
    w = min(NEW_CHART_TILE_W, GRID_COLUMNS)
    x, y = first_free_spot(dashboard.layout, w, NEW_CHART_TILE_H)
    tile = ChartTile(
        id=uuid.uuid4().hex[:12],
        type="chart",
        chart_id=payload.chart_id,
        x=x,
        y=y,
        w=w,
        h=NEW_CHART_TILE_H,
    )
    _set_layout(db, dashboard, [*dashboard.layout, tile.model_dump(mode="json")])
    _commit(db, dashboard.name, dashboard.project_id)
    db.expire_all()
    return _out(db, _get_or_404(db, dashboard_id))
