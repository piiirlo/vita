"""Usage checks of the datasets API: what saved charts, dashboard filters and other datasets
use, and the 409s that keep them from breaking."""

from typing import NoReturn

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.charts.usage import GROUP, TIME, QueryUsage, query_usage, used_by_message
from app.models import Chart, Dashboard, Dataset, DatasetColumn, DatasetMetric
from app.schemas.charts import ChartParams
from app.uploads.datasets import table_users


def dashboards_filtering_on(db: Session, dataset_id: int) -> list[str]:
    """Names of the dashboards with a values filter reading its choices from this dataset."""
    names = {
        d.name
        for d in db.scalars(select(Dashboard))
        if any(f.get("dataset_id") == dataset_id for f in d.filters or [])
    }
    return sorted(names, key=str.lower)


def chart_usages(db: Session, dataset: Dataset) -> list[tuple[str, QueryUsage]]:
    """(chart name, what it uses) for every saved chart on this dataset."""
    usages: list[tuple[str, QueryUsage]] = []
    for chart in db.scalars(select(Chart).where(Chart.dataset_id == dataset.id)):
        try:
            params = ChartParams.model_validate(chart.params)
        except ValueError:
            continue  # unreadable params can't be broken further
        usages.append((chart.name, query_usage(params.query, dataset.main_time_column)))
    return usages


def _blocked(what: str, chart_names: list[str]) -> NoReturn:
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        {"message": used_by_message(what, chart_names), "charts": sorted(chart_names)},
    )


def check_column_change(
    usages: list[tuple[str, QueryUsage]],
    col: DatasetColumn,
    *,
    removed: bool = False,
    hidden: bool = False,
    dimension: bool = True,
    temporal: bool = True,
) -> None:
    """Refuse a column change that would break saved charts using that column."""
    breaking: list[str] = []
    for chart_name, usage in usages:
        roles = usage.columns.get(col.name)
        if not roles:
            continue
        if (
            removed
            or (hidden and not col.is_hidden)
            or (GROUP in roles and not (dimension or temporal))
            or (TIME in roles and not temporal)
        ):
            breaking.append(chart_name)
    if breaking:
        _blocked(f'Column "{col.name}"', breaking)


def check_metric_unused(db: Session, dataset: Dataset, metric: DatasetMetric) -> None:
    """Saved charts refer to metrics by name: block deleting or renaming a used one."""
    users = [name for name, usage in chart_usages(db, dataset) if metric.name in usage.metrics]
    if users:
        _blocked(f'Metric "{metric.name}"', users)


def check_dataset_unused(db: Session, dataset: Dataset) -> None:
    """Refuse deleting a dataset that saved charts or dashboard filters use."""
    used_by = list(
        db.scalars(select(Chart.name).where(Chart.dataset_id == dataset.id).order_by(Chart.name))
    )
    if used_by:
        noun = "chart" if len(used_by) == 1 else "charts"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": f"This dataset is used by {len(used_by)} {noun}: "
                f"{', '.join(used_by)}. Delete those first.",
                "charts": used_by,
            },
        )
    filtered_by = dashboards_filtering_on(db, dataset.id)
    if filtered_by:
        noun = "dashboard" if len(filtered_by) == 1 else "dashboards"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": f"This dataset is used by the filters of {len(filtered_by)} {noun}: "
                f"{', '.join(filtered_by)}. Remove those filters first.",
                "dashboards": filtered_by,
            },
        )


def check_table_unused(db: Session, dataset: Dataset, table: str) -> None:
    """Refuse dropping an uploaded table that other datasets read."""
    others = table_users(db, dataset)
    if others:
        noun = "dataset uses" if len(others) == 1 else "datasets use"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": f"The table “{table}” can't be deleted: {len(others)} other "
                f"{noun} it ({', '.join(others)}). Delete only the dataset, or those first.",
                "datasets": others,
            },
        )
