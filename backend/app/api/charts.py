"""Chart data (POST /api/chart-data) and saved charts CRUD (/api/charts)."""

import logging
from dataclasses import asdict
from datetime import date, timedelta
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

from app.api.connections import saved_connection_details
from app.api.datasets import get_dataset_or_404
from app.charts import build_chart_query, cache
from app.db import get_db
from app.models import Chart, Dashboard, DashboardChart, Dataset
from app.query import DEFAULT_TIMEOUT_SECONDS, QueryError, run_query
from app.schemas.charts import ChartDataOut, ChartDataRequest, ChartIn, ChartOut, ChartParams
from app.schemas.query import QueryErrorOut

log = logging.getLogger(__name__)

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]

QUERY_ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: {"description": "Invalid chart query, or the query failed", "model": QueryErrorOut}
}


def _query_error(error: QueryError) -> NoReturn:
    raise HTTPException(status.HTTP_400_BAD_REQUEST, QueryErrorOut(**asdict(error)).model_dump())


# ---------- chart data ----------


def today() -> date:
    """ "Today" for relative time ranges (tests replace this)."""
    return date.today()


@router.post("/chart-data", response_model=ChartDataOut, responses=QUERY_ERROR_RESPONSES)
def chart_data(payload: ChartDataRequest, db: DbSession) -> ChartDataOut:
    """Build SQL from the chart query and run it (read-only, with timeout and row limit).
    Not logged in query_history."""
    dataset = get_dataset_or_404(db, payload.query.dataset_id)
    details = saved_connection_details(dataset.connection)
    try:
        built = build_chart_query(
            dataset, details.db_type, payload.viz_type, payload.query, today=today()
        )
    except QueryError as error:
        _query_error(error)
    range_fields = {
        "sql": built.sql,
        "range_start": built.time_start,
        "range_end": built.time_end - timedelta(days=1) if built.time_end else None,
    }
    connection = dataset.connection
    key = cache.cache_key(connection.id, connection.updated_at, built.sql, built.row_limit)
    ttl = cache.effective_ttl(payload.cache_ttl)
    if ttl > 0 and not payload.refresh:
        hit = cache.get(db, key)
        if hit is not None:
            return ChartDataOut(
                **_without_probe(hit.result, built.rows_probe),
                **range_fields,
                cached_at=hit.created_at,
            )
    connection_id = connection.id
    db.close()  # don't hold a metadata-DB connection while the user DB is queried

    try:
        result = run_query(
            details, built.sql, limit=built.row_limit, timeout_seconds=DEFAULT_TIMEOUT_SECONDS
        )
    except QueryError as error:
        _query_error(error)
    if ttl > 0:
        try:
            cache.put(db, key, connection_id, asdict(result), ttl)
        except SQLAlchemyError:
            # The result is fine; only caching it failed. Never fail the chart for that.
            db.rollback()
            log.exception("Couldn't cache chart data")
        finally:
            db.close()
    return ChartDataOut(**_without_probe(asdict(result), built.rows_probe), **range_fields)


def _without_probe(result: dict[str, Any], rows_probe: bool) -> dict[str, Any]:
    """Drop the builder's rows probe (last column, MIN of the time column). NULL there means no
    row was in the time range: return no rows, so "no data" never looks like a total of 0."""
    if not rows_probe:
        return result
    rows = [row[:-1] for row in result["rows"] if row[-1] is not None]
    return {**result, "columns": result["columns"][:-1], "rows": rows, "row_count": len(rows)}


# ---------- saved charts ----------


def _get_or_404(db: Session, chart_id: int) -> Chart:
    chart = db.scalar(
        select(Chart).where(Chart.id == chart_id).options(selectinload(Chart.dataset))
    )
    if chart is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Chart not found")
    return chart


def _out(chart: Chart) -> ChartOut:
    return ChartOut(
        id=chart.id,
        name=chart.name,
        description=chart.description,
        dataset_id=chart.dataset_id,
        dataset_name=chart.dataset_name,
        viz_type=chart.viz_type,
        params=ChartParams.model_validate(chart.params),
        created_at=chart.created_at,
        updated_at=chart.updated_at,
    )


def _check_name_free(db: Session, name: str, chart_id: int | None = None) -> None:
    stmt = select(Chart.id).where(func.lower(Chart.name) == name.lower())
    if chart_id is not None:
        stmt = stmt.where(Chart.id != chart_id)
    if db.scalar(stmt) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f'A chart named "{name}" already exists')


def _apply(db: Session, chart: Chart, payload: ChartIn) -> None:
    """Validate the chart's query against its dataset (no query is run) and copy fields."""
    name = payload.name.strip()
    _check_name_free(db, name, chart.id)
    dataset = db.get(Dataset, payload.params.query.dataset_id)
    if dataset is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The chart's dataset doesn't exist")
    dataset = get_dataset_or_404(db, dataset.id)  # with columns, metrics and connection
    query = payload.params.query
    time = query.time
    if time is not None and time.column is None and (time.grain or time.range.kind != "none"):
        # Store the column itself, so changing the dataset's main time column later doesn't
        # silently change this chart.
        time.column = dataset.main_time_column
    try:
        build_chart_query(dataset, dataset.connection.db_type, payload.viz_type, query)
    except QueryError as error:
        _query_error(error)
    chart.name = name
    chart.description = (payload.description or "").strip() or None
    chart.dataset_id = dataset.id
    chart.viz_type = payload.viz_type
    chart.params = payload.params.model_dump(mode="json")


def _commit(db: Session, name: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, f'A chart named "{name}" already exists'
        ) from None


@router.get("/charts", response_model=list[ChartOut])
def list_charts(
    db: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    dataset_id: int | None = None,
) -> list[ChartOut]:
    stmt = select(Chart).join(Chart.dataset).options(selectinload(Chart.dataset))
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Chart.name.ilike(pattern),
                Chart.description.ilike(pattern),
                Chart.viz_type.ilike(pattern),
                Dataset.name.ilike(pattern),
            )
        )
    if dataset_id is not None:
        stmt = stmt.where(Chart.dataset_id == dataset_id)
    stmt = stmt.order_by(Chart.updated_at.desc(), Chart.id.desc())
    return [_out(c) for c in db.scalars(stmt)]


@router.post(
    "/charts", response_model=ChartOut, status_code=status.HTTP_201_CREATED,
    responses=QUERY_ERROR_RESPONSES,
)  # fmt: skip
def create_chart(payload: ChartIn, db: DbSession) -> ChartOut:
    chart = Chart()
    _apply(db, chart, payload)
    db.add(chart)
    _commit(db, chart.name)
    return _out(_get_or_404(db, chart.id))


@router.get("/charts/{chart_id}", response_model=ChartOut)
def get_chart(chart_id: int, db: DbSession) -> ChartOut:
    return _out(_get_or_404(db, chart_id))


@router.put("/charts/{chart_id}", response_model=ChartOut, responses=QUERY_ERROR_RESPONSES)
def update_chart(chart_id: int, payload: ChartIn, db: DbSession) -> ChartOut:
    chart = _get_or_404(db, chart_id)
    _apply(db, chart, payload)
    _commit(db, chart.name)
    db.expire_all()
    return _out(_get_or_404(db, chart_id))


@router.delete("/charts/{chart_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart(chart_id: int, db: DbSession) -> Response:
    chart = _get_or_404(db, chart_id)
    used_by = list(
        db.scalars(
            select(Dashboard.name)
            .join(DashboardChart, DashboardChart.dashboard_id == Dashboard.id)
            .where(DashboardChart.chart_id == chart.id)
            .order_by(Dashboard.name)
        )
    )
    if used_by:
        noun = "dashboard" if len(used_by) == 1 else "dashboards"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": f"This chart is used by {len(used_by)} {noun}: "
                f"{', '.join(used_by)}. Remove it from those dashboards first.",
                "dashboards": used_by,
            },
        )
    db.delete(chart)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
