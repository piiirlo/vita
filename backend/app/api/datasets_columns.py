"""Column rules of the datasets API: applying the user's column settings on update, which
columns may be time columns, the main time column, and removing vanished columns."""

from fastapi import HTTPException, status

from app.api.datasets_common import clean, details_of, query_error
from app.api.datasets_usage import check_column_change
from app.charts.usage import QueryUsage
from app.datasets import source_of
from app.datasets.timecols import (
    DATE_FORMAT_LABELS,
    add_note,
    check_text_dates,
    number_stats,
    text_date_note,
)
from app.models import Dataset, DatasetColumn
from app.query import QueryError
from app.schemas.datasets import ColumnSettings


def main_time_column_problem(dataset: Dataset, name: str | None) -> str | None:
    if name is None:
        return None
    col = next((c for c in dataset.columns if c.name == name), None)
    if col is None or col.is_missing:
        return f'Main time column "{name}" is not a column of this dataset'
    if not col.is_temporal:
        return f'Main time column "{name}" must be marked as temporal'
    return None


def _time_kinds(
    dataset: Dataset, settings_list: list[ColumnSettings]
) -> dict[int, tuple[str | None, str | None]]:
    """(time_kind, text_date_format) for every column in the payload. Marking a column as
    time is only allowed for dates and datetimes, numbers that are all years (a year
    number) and text that reads as dates (a text date; values that don't are counted in a
    note). Checking runs queries on the user database (only for columns that change)."""
    out: dict[int, tuple[str | None, str | None]] = {}
    by_id = {c.id: c for c in dataset.columns}
    numbers: list[DatasetColumn] = []
    texts: list[tuple[DatasetColumn, ColumnSettings]] = []
    for settings in settings_list:
        col = by_id[settings.id]
        new_type = settings.generic_type_override or col.generic_type
        if not settings.is_temporal or new_type in ("date", "datetime"):
            out[col.id] = (None, None)
        elif (
            col.is_temporal
            and col.time_kind is not None
            and col.effective_type == new_type
            and settings.text_date_format in (None, col.text_date_format)
        ):
            out[col.id] = (col.time_kind, col.text_date_format)  # unchanged (or pending)
        elif new_type == "number":
            numbers.append(col)
        elif new_type == "string":
            texts.append((col, settings))
        else:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"“{col.name}” ({new_type}) can't be a time column. Time columns are "
                "dates, datetimes, years (whole numbers like 2024) or text dates.",
            )
    if not numbers and not texts:
        return out
    details = details_of(dataset)
    source = source_of(dataset)
    try:
        stats = number_stats(details, source, [c.name for c in numbers])
        for col in numbers:
            if not stats[col.name].fits_years():
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"“{col.name}” can't be a time column: its values aren't years "
                    "(whole numbers like 2024, between 1000 and 9999).",
                )
            out[col.id] = ("year_number", None)
        for col, settings in texts:
            check = check_text_dates(details, source, col.name, settings.text_date_format)
            if check.order is None:
                why = (
                    "its dates read both as day/month and month/day. Pick the date order."
                    if check.ambiguous
                    else "its values don't look like dates (e.g. 2024-03-15 or 15/03/2024)."
                )
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"“{col.name}” can't be a time column: {why}",
                )
            if check.values and check.failures == check.values:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"“{col.name}” can't be a time column: none of its values are "
                    f"dates in {DATE_FORMAT_LABELS[check.order]}. Pick another date order.",
                )
            note = text_date_note(col.name, check)
            if note:
                add_note(dataset, note)
            out[col.id] = ("text_date", check.order)
    except QueryError as error:
        query_error(error)
    return out


def apply_column_settings(
    dataset: Dataset, settings_list: list[ColumnSettings], usages: list[tuple[str, QueryUsage]]
) -> None:
    """Apply the payload's column settings, refusing changes that break saved charts."""
    by_id = {c.id: c for c in dataset.columns}
    for settings in settings_list:
        if settings.id not in by_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Column {settings.id} is not part of this dataset"
            )
    time_kinds = _time_kinds(dataset, settings_list)
    for settings in settings_list:
        col = by_id[settings.id]
        check_column_change(
            usages,
            col,
            hidden=settings.is_hidden,
            dimension=settings.is_dimension,
            temporal=settings.is_temporal,
        )
        col.label = clean(settings.label)
        col.generic_type_override = settings.generic_type_override
        col.is_temporal = settings.is_temporal
        col.time_kind, col.text_date_format = time_kinds[col.id]
        if settings.is_identifier is not None:
            col.is_identifier = settings.is_identifier
        if col.is_temporal:
            col.looks_like_years = False
        col.is_dimension = settings.is_dimension
        col.is_hidden = settings.is_hidden
        col.description = clean(settings.description)
        if settings.value_labels is not None:
            labels = {k: v.strip() for k, v in settings.value_labels.items() if v.strip()}
            col.value_labels = labels or None


def delete_missing_columns(
    dataset: Dataset, column_ids: list[int], usages: list[tuple[str, QueryUsage]]
) -> None:
    """Remove columns that vanished from the database (only those, and only if unused)."""
    by_id = {c.id: c for c in dataset.columns}
    for column_id in column_ids:
        col = by_id.get(column_id)
        if col is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Column {column_id} is not part of this dataset"
            )
        if not col.is_missing:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f'Column "{col.name}" still exists in the database; hide it instead',
            )
        check_column_change(usages, col, removed=True)
        dataset.columns.remove(col)
