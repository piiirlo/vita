"""Time columns that aren't dates in the database: year numbers and text dates.

A temporal column's `time_kind` says how it becomes a DATE in chart SQL (`time_value`):
- None:          a DATE / TIMESTAMP column, used as is.
- "year_number": whole numbers like 2006 -> 2006-01-01 (Postgres make_date, MySQL MAKEDATE).
                 Only the year grain (and raw values) make sense for it.
- "text_date":   text like "9/11/2013" read in `text_date_format` (ymd / dmy / mdy); any of
                 - / . separate the parts and a time after a space or "T" is ignored.
- "pending":     a number / text column marked temporal before Part 13. Checked lazily
                 (`resolve_pending`: dataset page, Sync columns, chart data, preview), never
                 at startup; until then charts get a clear error.

Every expression is safe: a value that isn't a valid year / date becomes NULL, never a
database error (Postgres make_date would raise on month 13, so each step is guarded by a
CASE, which Postgres evaluates in order).

Detection (upload, Sync, dataset creation): a number column with a year-like name and whole
values all between 1900 and 2100 becomes a year-number time column; values alone only set
`looks_like_years` (the Columns tab suggests it). Identifier-like names (row_id, postal_code,
zip, phone...) set `is_identifier`: not offered for SUM / AVG.
"""

import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import sqlglot
from sqlglot import exp

from app.datasets.sql import DatasetSource, column, dialect_for, from_clause, select_sql
from app.engines import ConnectionDetails
from app.query import DEFAULT_TIMEOUT_SECONDS, QueryError, run_query
from app.uploads.types import DateOrder, guess_date_order

# Detection: values in this range (and a year-like name) make a year column automatically.
AUTO_YEAR_MIN, AUTO_YEAR_MAX = 1900, 2100
# What a year-number column may hold at all (4-digit years; make_date / MAKEDATE handle them).
YEAR_MIN, YEAR_MAX = 1000, 9999
# A text column can be a time column when at most this share of its values fail to parse.
TEXT_DATE_MAX_FAILURES = 0.1
TEXT_DATE_SAMPLE = 1000

TIME_KINDS = ("year_number", "text_date", "pending")
DATE_FORMAT_LABELS: dict[str, str] = {
    "ymd": "YYYY-MM-DD",
    "dmy": "DD-MM-YYYY",
    "mdy": "MM-DD-YYYY",
}

_YEAR_TOKENS = frozenset({"year", "years", "yr", "yrs", "annee", "annees", "anno", "ano", "jahr"})
IDENTIFIER_TOKENS = frozenset(
    {
        "id", "uuid", "guid", "key", "code", "zip", "zipcode", "postal", "postcode", "phone",
        "tel", "telephone", "fax", "sku", "ean", "upc", "isbn", "gtin", "iban", "ssn", "rank",
    }
)  # fmt: skip
# Uploads: columns named like this are always text (leading zeros, "+33...", codes).
# Id-like names (id, key, rank...) aren't: they are text only when their values are (not
# plain numbers, or with leading zeros: the guess decides), else numbers that sort
# numerically, flagged as identifiers.
CODE_TOKENS = IDENTIFIER_TOKENS - {"id", "uuid", "guid", "key", "rank"}


def name_tokens(name: str) -> list[str]:
    """ "Order Date" / "orderDate" / "Année" -> ["order", "date"] / ["order", "date"] /
    ["annee"]: camelCase split, accents stripped, lower case, split on anything else."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    plain = "".join(
        ch for ch in unicodedata.normalize("NFKD", spaced) if not unicodedata.combining(ch)
    )
    return [t for t in re.split(r"[^a-z0-9]+", plain.lower()) if t]


def is_year_name(name: str) -> bool:
    return any(t in _YEAR_TOKENS for t in name_tokens(name))


def is_identifier_name(name: str) -> bool:
    return any(t in IDENTIFIER_TOKENS for t in name_tokens(name))


def is_code_name(name: str) -> bool:
    return any(t in CODE_TOKENS for t in name_tokens(name))


# ---------- SQL ----------

_COL = "__vita_col__"
_PG_PART = f"SPLIT_PART(SPLIT_PART(TRIM({_COL}), ' ', 1), 'T', 1)"
_MYSQL_PART = f"SUBSTRING_INDEX(SUBSTRING_INDEX(TRIM({_COL}), ' ', 1), 'T', 1)"
_REGEX = {
    "ymd": "^[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}$",
    "dmy": "^[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4}$",
    "mdy": "^[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4}$",
}
# Which part (1-3) holds the year, month and day.
_POSITIONS = {"ymd": (1, 2, 3), "dmy": (3, 2, 1), "mdy": (3, 1, 2)}
_MYSQL_FORMATS = {"ymd": "%Y-%m-%d", "dmy": "%d-%m-%Y", "mdy": "%m-%d-%Y"}


def _year_template(db_type: str) -> str:
    guard = f"{_COL} BETWEEN {YEAR_MIN} AND {YEAR_MAX} AND {_COL} = FLOOR({_COL})"
    if db_type == "postgresql":
        return f"CASE WHEN {guard} THEN MAKE_DATE(CAST({_COL} AS INT), 1, 1) END"
    return f"CASE WHEN {guard} THEN MAKEDATE({_COL}, 1) END"


def _text_template(db_type: str, order: str) -> str:
    regex = _REGEX[order]
    if db_type == "postgresql":
        normalized = f"TRANSLATE({_PG_PART}, '/.', '--')"
        y, m, d = (f"CAST(SPLIT_PART({normalized}, '-', {i}) AS INT)" for i in _POSITIONS[order])
        first = f"MAKE_DATE({y}, {m}, 1)"
        last_day = f"EXTRACT(DAY FROM {first} + INTERVAL '1 month' - INTERVAL '1 day')"
        return (
            f"CASE WHEN {_PG_PART} ~ '{regex}' THEN "
            f"CASE WHEN {m} BETWEEN 1 AND 12 AND {y} >= 1 THEN "
            f"CASE WHEN {d} BETWEEN 1 AND {last_day} THEN MAKE_DATE({y}, {m}, {d}) END END END"
        )
    normalized = f"REPLACE(REPLACE({_MYSQL_PART}, '/', '-'), '.', '-')"
    # STR_TO_DATE returns NULL (with a warning) for impossible dates like 30-02-2013.
    return (
        f"CASE WHEN {_MYSQL_PART} REGEXP '{regex}' "
        f"THEN STR_TO_DATE({normalized}, '{_MYSQL_FORMATS[order]}') END"
    )


def _from_template(template: str, ref: exp.Expr, db_type: str) -> exp.Expr:
    dialect = "postgres" if db_type == "postgresql" else "mysql"
    parsed = sqlglot.parse_one(template, read=dialect)
    return parsed.transform(
        lambda node: ref.copy() if isinstance(node, exp.Column) and node.name == _COL else node
    )


def time_expression(
    ref: exp.Expr, time_kind: str | None, text_date_format: str | None, db_type: str
) -> exp.Expr:
    """`ref` (a column) as a DATE / TIMESTAMP, per the column's time kind."""
    if db_type not in ("postgresql", "mysql"):
        raise QueryError("invalid", f"Unsupported database type: {db_type}")
    if time_kind is None:
        return ref.copy()
    if time_kind == "year_number":
        return _from_template(_year_template(db_type), ref, db_type)
    if time_kind == "text_date":
        return _from_template(_text_template(db_type, text_date_format or "ymd"), ref, db_type)
    raise ValueError(f"No time expression for time_kind {time_kind!r}")


def time_value(col: Any, db_type: str) -> exp.Expr:
    """A temporal DatasetColumn as a DATE / TIMESTAMP expression. Raises QueryError for a
    column that couldn't be checked yet ("pending")."""
    if col.time_kind == "pending":
        raise QueryError(
            "invalid",
            f'"{col.name}" is marked as a time column, but it isn\'t a date column and its '
            "values couldn't be checked yet. Open the dataset (or Sync columns) to check it "
            "again; if the database is unreachable, try later.",
        )
    return time_expression(column(col.name), col.time_kind, col.text_date_format, db_type)


def allowed_grains(col: Any) -> set[str] | None:
    """Grains a temporal column supports (None: all). Year numbers only have years."""
    if col.time_kind == "year_number":
        return {"year", "raw"}
    return None


# ---------- checks on the user database ----------


@dataclass(frozen=True)
class NumberStats:
    count: int  # non-NULL values
    minimum: float | None
    maximum: float | None
    fractional: int  # values that aren't whole

    def fits_years(self, low: int = YEAR_MIN, high: int = YEAR_MAX) -> bool:
        """Every value is a whole number in [low, high] (no values: fits)."""
        if self.count == 0:
            return True
        assert self.minimum is not None
        assert self.maximum is not None
        return self.fractional == 0 and low <= self.minimum and self.maximum <= high

    def auto_years(self) -> bool:
        """Values that are years for detection: some values, all whole, 1900-2100."""
        return self.count > 0 and self.fits_years(AUTO_YEAR_MIN, AUTO_YEAR_MAX)


def _number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    return float(str(value))


def number_stats(
    details: ConnectionDetails,
    source: DatasetSource,
    names: list[str],
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, NumberStats]:
    """COUNT, MIN, MAX and how many values aren't whole, for number columns: one query."""
    if not names:
        return {}
    selects: list[exp.Expr] = []
    for i, name in enumerate(names):
        ref = column(name)
        not_whole = exp.Case(
            ifs=[
                exp.If(
                    this=exp.NEQ(this=ref.copy(), expression=exp.Floor(this=ref.copy())),
                    true=exp.Literal.number(1),
                )
            ],
            default=exp.Literal.number(0),
        )
        selects += [
            exp.Count(this=ref.copy()).as_(f"c{i}", quoted=True),
            exp.Min(this=ref.copy()).as_(f"lo{i}", quoted=True),
            exp.Max(this=ref.copy()).as_(f"hi{i}", quoted=True),
            exp.Sum(this=not_whole).as_(f"f{i}", quoted=True),
        ]
    sql = select_sql(source, details.db_type, selects)
    result = run_query(details, sql, limit=1, timeout_seconds=timeout_seconds)
    row = result.rows[0] if result.rows else [None] * len(selects)
    out: dict[str, NumberStats] = {}
    for i, name in enumerate(names):
        count, low, high, fractional = row[4 * i : 4 * i + 4]
        out[name] = NumberStats(
            count=int(count or 0),
            minimum=_number(low),
            maximum=_number(high),
            fractional=int(fractional or 0),
        )
    return out


@dataclass(frozen=True)
class TextDateCheck:
    order: DateOrder | None  # None: no date order fits, or it's ambiguous
    ambiguous: bool
    values: int  # non-empty values
    failures: int  # ...that don't read as a date in `order`


def check_text_dates(
    details: ConnectionDetails,
    source: DatasetSource,
    name: str,
    order: DateOrder | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> TextDateCheck:
    """Guess a text column's date order from a sample of its values (unless given), then
    count, with the real SQL expression, how many values don't parse."""
    ambiguous = False
    if order is None:
        ref = column(name)
        sample_sql = (
            exp.select(ref.copy())
            .distinct()
            .from_(from_clause(source, details.db_type))
            .where(exp.Not(this=exp.Is(this=ref.copy(), expression=exp.Null())))
            .limit(TEXT_DATE_SAMPLE)
        )
        sample = run_query(
            details,
            sample_sql.sql(dialect=dialect_for(details.db_type)),
            limit=TEXT_DATE_SAMPLE,
            timeout_seconds=timeout_seconds,
        )
        values = [str(r[0]) for r in sample.rows if r[0] is not None and str(r[0]).strip()]
        order, ambiguous = guess_date_order(values)
        if order is None:
            return TextDateCheck(None, ambiguous, len(values), len(values))
    ref = column(name)
    trimmed = exp.Nullif(this=exp.Trim(this=ref.copy()), expression=exp.Literal.string(""))
    parsed = time_expression(ref, "text_date", order, details.db_type)
    sql = select_sql(
        source,
        details.db_type,
        [
            exp.Count(this=trimmed).as_("n", quoted=True),
            exp.Count(this=parsed).as_("ok", quoted=True),
        ],
    )
    result = run_query(details, sql, limit=1, timeout_seconds=timeout_seconds)
    count, ok = result.rows[0] if result.rows else (0, 0)
    return TextDateCheck(order, ambiguous, int(count or 0), int(count or 0) - int(ok or 0))


# ---------- notes ----------


def add_note(dataset: Any, message: str) -> None:
    """A note on the dataset page about something Vita changed on its own."""
    note = {"id": uuid.uuid4().hex, "message": message, "created_at": datetime.now(UTC).isoformat()}
    # A new list: SQLAlchemy doesn't see in-place changes of a JSON value.
    dataset.notes = [*(dataset.notes or []), note]


def text_date_note(name: str, check: TextDateCheck) -> str | None:
    if not check.failures or check.order is None:
        return None
    return (
        f"“{name}”: {check.failures:,} of {check.values:,} values aren't dates in "
        f"{DATE_FORMAT_LABELS[check.order]}; charts show them as “(empty)”."
    )


# ---------- lazy reclassification ----------


@dataclass
class PendingResult:
    """What to do with one "pending" column."""

    name: str
    time_kind: str | None  # None: unmark it
    text_date_format: DateOrder | None = None
    note: str = ""


def check_pending(
    details: ConnectionDetails, source: DatasetSource, columns: list[Any]
) -> list[PendingResult]:
    """Decide what each pending column becomes. Runs queries (raises QueryError); applies
    nothing, so it can run without a metadata-DB session."""
    results: list[PendingResult] = []
    pending = [c for c in columns if c.time_kind == "pending" and not c.is_missing]
    numbers = [c.name for c in pending if c.effective_type == "number"]
    stats = number_stats(details, source, numbers) if numbers else {}
    for col in pending:
        kind = col.effective_type
        if kind in ("date", "datetime"):
            results.append(PendingResult(col.name, None, note=""))
            continue
        if kind == "number":
            s = stats[col.name]
            if s.fits_years():
                results.append(
                    PendingResult(
                        col.name,
                        "year_number",
                        note=f"“{col.name}” holds years, so it is now a year (number) time "
                        "column: charts can group it by year.",
                    )
                )
            else:
                results.append(
                    PendingResult(
                        col.name,
                        None,
                        note=f"“{col.name}” was marked as a time column, but its values aren't "
                        "years or dates, so it is no longer a time column. Charts that used it "
                        "for time need another time column.",
                    )
                )
            continue
        if kind == "string":
            check = check_text_dates(details, source, col.name)
            if (
                check.order is not None
                and check.values
                and check.failures / check.values <= TEXT_DATE_MAX_FAILURES
            ):
                note = (
                    f"“{col.name}” holds dates as text ({DATE_FORMAT_LABELS[check.order]}); "
                    "charts now read them as dates."
                )
                extra = text_date_note(col.name, check)
                results.append(
                    PendingResult(
                        col.name, "text_date", check.order, note + (f" {extra}" if extra else "")
                    )
                )
            else:
                why = (
                    "its dates read both as day/month and month/day: mark it again and pick the "
                    "order"
                    if check.ambiguous
                    else "its values aren't dates"
                )
                results.append(
                    PendingResult(
                        col.name,
                        None,
                        note=f"“{col.name}” is no longer a time column: {why}.",
                    )
                )
            continue
        results.append(
            PendingResult(
                col.name,
                None,
                note=f"“{col.name}” ({kind}) can't be a time column, so it was unmarked.",
            )
        )
    return results


def apply_pending(dataset: Any, results: list[PendingResult]) -> None:
    by_name = {c.name: c for c in dataset.columns}
    for r in results:
        col = by_name.get(r.name)
        if col is None or col.time_kind != "pending":
            continue
        if r.time_kind is None and col.effective_type not in ("date", "datetime"):
            col.is_temporal = False
            col.time_kind = None
            col.text_date_format = None
            if dataset.main_time_column == col.name:
                dataset.main_time_column = None
        else:
            col.time_kind = r.time_kind
            col.text_date_format = r.text_date_format
        if r.note:
            add_note(dataset, r.note)


def has_pending(dataset: Any) -> bool:
    return any(c.time_kind == "pending" and not c.is_missing for c in dataset.columns)


__all__ = [
    "DATE_FORMAT_LABELS",
    "NumberStats",
    "PendingResult",
    "TextDateCheck",
    "add_note",
    "allowed_grains",
    "apply_pending",
    "check_pending",
    "check_text_dates",
    "has_pending",
    "is_code_name",
    "is_identifier_name",
    "is_year_name",
    "name_tokens",
    "number_stats",
    "text_date_note",
    "time_expression",
    "time_value",
]
