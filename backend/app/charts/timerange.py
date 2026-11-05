"""Turn a time range into [start, end) dates. Computed in Python from `today` (injectable,
so tests are deterministic), then compared as DATE literals in SQL."""

import calendar
from datetime import date, timedelta

from app.schemas.charts import Grain, TimeRange


def _months_back(day: date, months: int) -> date:
    """The same day `months` earlier (clamped to the end of shorter months)."""
    year, month = divmod(day.year * 12 + day.month - 1 - months, 12)
    month += 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def time_bounds(time_range: TimeRange, today: date) -> tuple[date | None, date | None]:
    """(start inclusive, end exclusive). None means open on that side."""
    tomorrow = today + timedelta(days=1)
    match time_range.kind:
        case "none":
            return None, None
        case "last_7_days":
            return today - timedelta(days=7), tomorrow
        case "last_30_days":
            return today - timedelta(days=30), tomorrow
        case "last_90_days":
            return today - timedelta(days=90), tomorrow
        case "last_12_months":
            return _months_back(today, 12), tomorrow
        case "this_year":
            return date(today.year, 1, 1), date(today.year + 1, 1, 1)
        case "last_year":
            return date(today.year - 1, 1, 1), date(today.year, 1, 1)
        case "custom":
            end = time_range.end + timedelta(days=1) if time_range.end else None
            return time_range.start, end


def bucket_start(day: date, grain: Grain) -> date:
    """The first day of the grain bucket `day` falls in (weeks start on Monday)."""
    match grain:
        case "day":
            return day
        case "week":
            return day - timedelta(days=day.weekday())
        case "month":
            return day.replace(day=1)
        case "quarter":
            return date(day.year, 3 * ((day.month - 1) // 3) + 1, 1)
        case "year":
            return date(day.year, 1, 1)


def aligned_bounds(
    time_range: TimeRange, today: date, grain: Grain | None
) -> tuple[date | None, date | None]:
    """time_bounds, with the start snapped back to the beginning of its grain bucket so the
    first bucket is a whole period. Without a grain the exact dates are kept."""
    start, end = time_bounds(time_range, today)
    if grain is not None and start is not None:
        start = bucket_start(start, grain)
    return start, end
