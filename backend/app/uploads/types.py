"""Column types of uploaded files: guessing them from a sample, and converting values.

The same parsers are used to guess (on a sample), to show the preview and to import, so
what the preview says fits is exactly what gets imported.
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal

ColumnType = Literal["text", "integer", "decimal", "date", "datetime", "boolean"]
COLUMN_TYPES: tuple[ColumnType, ...] = ("text", "integer", "decimal", "date", "datetime", "boolean")
# Postgres types of the uploaded table.
PG_TYPES: dict[ColumnType, str] = {
    "text": "TEXT",
    "integer": "BIGINT",
    "decimal": "NUMERIC",
    "date": "DATE",
    "datetime": "TIMESTAMP",
    "boolean": "BOOLEAN",
}
DateOrder = Literal["ymd", "dmy", "mdy"]
Decimal_ = Literal[".", ","]
Thousands = Literal["", ",", ".", " ", "'"]

# Empty cells are NULL for every type; these words too, except in text columns.
NULL_WORDS = frozenset({"null", "na", "n/a", "nan", "none", "#n/a"})
TRUE_WORDS = frozenset({"true", "t", "yes", "y", "oui", "vrai"})
FALSE_WORDS = frozenset({"false", "f", "no", "n", "non", "faux"})
_BIGINT = 2**63 - 1
# Spaces used as thousands separators (normal, no-break, narrow no-break).
_SPACES = "   "


class ConvertError(ValueError):
    """A value doesn't fit its column's type."""


@dataclass(frozen=True)
class NumberFormat:
    decimal: Decimal_ = "."
    thousands: Thousands = ""


# ---------- numbers ----------

_PLAIN_NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")


def parse_decimal(text: str, fmt: NumberFormat) -> Decimal:
    s = text.strip()
    if fmt.thousands == " ":
        s = s.translate({ord(c): None for c in _SPACES})
    elif fmt.thousands:
        # Thousands groups must be groups of three ("1.234.567", not "1.23").
        other = re.escape(fmt.decimal)
        sep = re.escape(fmt.thousands)
        if fmt.thousands in s and not re.fullmatch(
            rf"[+-]?\d{{1,3}}({sep}\d{{3}})+({other}\d*)?", s
        ):
            raise ConvertError(text)
        s = s.replace(fmt.thousands, "")
    if fmt.decimal == ",":
        if "." in s:
            raise ConvertError(text)
        s = s.replace(",", ".")
    if not _PLAIN_NUMBER.match(s):
        raise ConvertError(text)
    try:
        return Decimal(s)
    except InvalidOperation:
        raise ConvertError(text) from None


def parse_integer(text: str, fmt: NumberFormat) -> int:
    value = parse_decimal(text, fmt)
    if (
        value != value.to_integral_value()
        or "e" in text.lower()
        or fmt.decimal in text.strip().lstrip("+-")
    ):
        raise ConvertError(text)
    n = int(value)
    if abs(n) > _BIGINT:
        raise ConvertError(text)
    return n


def detect_number_format(values: list[str]) -> NumberFormat:
    """Decimal and thousands separators from the numbers in a sample: "4,20" means a decimal
    comma; "1.234,56" a decimal comma with dot thousands; "1 234,5" space thousands..."""
    comma_dec = dot_dec = 0
    thousands: Counter[str] = Counter()
    weak_comma_groups = weak_dot_groups = 0
    for raw in values:
        v = raw.strip()
        if not v or not re.search(r"\d", v) or not re.fullmatch(rf"[+-]?[\d.,'{_SPACES}]+", v):
            continue
        has_comma, has_dot = "," in v, "." in v
        if re.fullmatch(rf"[+-]?\d{{1,3}}([{_SPACES}]\d{{3}})+([.,]\d+)?", v):
            thousands[" "] += 1
            if "," in v:
                comma_dec += 1
            elif "." in v:
                dot_dec += 1
        elif re.fullmatch(r"[+-]?\d{1,3}('\d{3})+(\.\d+)?", v):
            thousands["'"] += 1
            dot_dec += "." in v
        elif has_comma and has_dot:
            if v.rfind(",") > v.rfind("."):
                comma_dec += 1
                thousands["."] += 1
            else:
                dot_dec += 1
                thousands[","] += 1
        elif has_comma:
            if re.fullmatch(r"[+-]?\d{1,3}(,\d{3})+", v):
                weak_comma_groups += 1  # "1,234": thousands, or a decimal with 3 digits
            elif re.fullmatch(r"[+-]?\d*,\d+", v):
                comma_dec += 1
        elif has_dot:
            if re.fullmatch(r"[+-]?\d{1,3}(\.\d{3})+", v) and v.count(".") > 1:
                weak_dot_groups += 1
            elif re.fullmatch(r"[+-]?\d*\.\d+", v):
                dot_dec += 1
    decimal: Decimal_ = "," if comma_dec > dot_dec else "."
    sep: Thousands = ""
    if thousands:
        candidate = thousands.most_common(1)[0][0]
        if candidate != decimal:
            sep = candidate  # type: ignore[assignment]
    elif decimal == "," and weak_dot_groups:
        sep = "."
    elif decimal == "." and weak_comma_groups and not comma_dec:
        sep = ","
    return NumberFormat(decimal, sep)


# ---------- booleans ----------


def parse_boolean(text: str) -> bool:
    word = text.strip().lower()
    if word in TRUE_WORDS:
        return True
    if word in FALSE_WORDS:
        return False
    raise ConvertError(text)


# ---------- dates ----------

_DATE = re.compile(r"^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})$")
_DATETIME = re.compile(
    r"^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})[T ](\d{1,2}):(\d{2})"
    r"(?::(\d{2})(?:[.,](\d{1,6})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?$"
)


def _ymd(a: str, b: str, c: str, order: DateOrder) -> tuple[int, int, int] | None:
    if order == "ymd":
        if len(a) != 4:
            return None
        return int(a), int(b), int(c)
    if len(c) != 4 or len(a) > 2:
        return None
    day, month = (int(a), int(b)) if order == "dmy" else (int(b), int(a))
    return int(c), month, day


def _valid(ymd: tuple[int, int, int] | None) -> date | None:
    if ymd is None:
        return None
    try:
        return date(*ymd)
    except ValueError:
        return None


def date_orders(text: str) -> set[DateOrder]:
    """The orders a date or datetime value can be read in (empty: not a date)."""
    s = text.strip()
    m = _DATE.match(s) or _DATETIME.match(s)
    if not m:
        return set()
    a, b, c = m.group(1), m.group(3), m.group(4)
    orders: tuple[DateOrder, ...] = ("ymd", "dmy", "mdy")
    return {o for o in orders if _valid(_ymd(a, b, c, o))}


def parse_date(text: str, order: DateOrder) -> date:
    m = _DATE.match(text.strip())
    if not m:
        raise ConvertError(text)
    value = _valid(_ymd(m.group(1), m.group(3), m.group(4), order))
    if value is None:
        raise ConvertError(text)
    return value


def parse_datetime(text: str, order: DateOrder) -> datetime:
    """Date and time (a plain date is midnight). An offset (Z, +02:00) is converted to UTC."""
    s = text.strip()
    m = _DATETIME.match(s)
    if not m:
        return datetime.combine(parse_date(s, order), datetime.min.time())
    day = _valid(_ymd(m.group(1), m.group(3), m.group(4), order))
    if day is None:
        raise ConvertError(text)
    hour, minute, second = int(m.group(5)), int(m.group(6)), int(m.group(7) or 0)
    micro = int((m.group(8) or "0").ljust(6, "0"))
    try:
        value = datetime(day.year, day.month, day.day, hour, minute, second, micro)
    except ValueError:
        raise ConvertError(text) from None
    zone = m.group(9)
    if zone:
        if zone == "Z":
            offset = timedelta(0)
        else:
            sign = -1 if zone[0] == "-" else 1
            digits = zone[1:].replace(":", "")
            offset = sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
        value = value.replace(tzinfo=timezone(offset)).astimezone(UTC).replace(tzinfo=None)
    return value


# ---------- converting ----------


def is_null(text: str | None, column_type: ColumnType) -> bool:
    if text is None or not text.strip():
        return True
    return column_type != "text" and text.strip().lower() in NULL_WORDS


def convert(
    text: str | None, column_type: ColumnType, fmt: NumberFormat, order: DateOrder | None
) -> object:
    """A cell as the Python value to load, or None. Raises ConvertError."""
    if is_null(text, column_type):
        return None
    assert text is not None
    match column_type:
        case "text":
            return text
        case "integer":
            return parse_integer(text, fmt)
        case "decimal":
            return parse_decimal(text, fmt)
        case "boolean":
            return parse_boolean(text)
        case "date":
            return parse_date(text, order or "ymd")
        case "datetime":
            return parse_datetime(text, order or "ymd")


# ---------- guessing ----------

# More specific types first: on a tie, the more specific one wins.
_SPECIFICITY: tuple[ColumnType, ...] = ("boolean", "integer", "decimal", "date", "datetime", "text")
# A type is guessed when at least this share of the non-empty values fit it.
GUESS_THRESHOLD = 0.9


@dataclass
class ColumnGuess:
    type: ColumnType
    # Dates: the order, or None when every value reads both ways (03/04/2024: ask).
    date_order: DateOrder | None = None
    date_ambiguous: bool = False
    non_null: int = 0


@dataclass
class Fit:
    misfits: int = 0
    examples: list[tuple[int, str]] = field(default_factory=list)  # (row number, value)


def _date_order_for(values: list[str]) -> tuple[DateOrder | None, bool, int]:
    """The best order for date-like values: (order, ambiguous, how many fit it)."""
    counts: Counter[DateOrder] = Counter()
    dated = 0
    for v in values:
        orders = date_orders(v)
        if orders:
            dated += 1
            counts.update(orders)
    if not counts:
        return None, False, 0
    if counts["ymd"] >= max(counts["dmy"], counts["mdy"]):
        return "ymd", False, counts["ymd"]
    if counts["dmy"] == counts["mdy"]:
        # Every value reads both ways (no day above 12): the user has to say which.
        return None, True, counts["dmy"]
    best: DateOrder = "dmy" if counts["dmy"] > counts["mdy"] else "mdy"
    return best, False, counts[best]


def _fits(value: str, column_type: ColumnType, fmt: NumberFormat, order: DateOrder | None) -> bool:
    try:
        if column_type in ("date", "datetime") and order is None:
            # Ambiguous order: fits when it reads as a date one way or the other.
            orders = date_orders(value)
            if column_type == "date":
                return bool(orders) and _DATE.match(value.strip()) is not None
            return bool(orders)
        convert(value, column_type, fmt, order)
        return True
    except ConvertError:
        return False


def guess_column(values: list[str], fmt: NumberFormat) -> ColumnGuess:
    """The type most values fit (>= 90%), most specific on a tie; else text."""
    present = [v for v in values if not is_null(v, "integer")]
    if not present:
        return ColumnGuess("text", non_null=0)
    order, ambiguous, _ = _date_order_for(present)
    best: ColumnType = "text"
    best_share = 0.0
    for column_type in _SPECIFICITY[:-1]:
        share = sum(_fits(v, column_type, fmt, order) for v in present) / len(present)
        if share >= GUESS_THRESHOLD and share > best_share + 1e-9:
            best, best_share = column_type, share
    guess = ColumnGuess(best, non_null=len(present))
    if best in ("date", "datetime"):
        guess.date_order = order
        guess.date_ambiguous = ambiguous
    return guess


def check_fit(
    values: list[tuple[int, str | None]],
    column_type: ColumnType,
    fmt: NumberFormat,
    order: DateOrder | None,
    examples: int = 5,
) -> Fit:
    """How many (row, value) pairs don't fit, with the first few as examples."""
    fit = Fit()
    for row, value in values:
        if is_null(value, column_type) or value is None:
            continue
        if not _fits(value, column_type, fmt, order):
            fit.misfits += 1
            if len(fit.examples) < examples:
                fit.examples.append((row, value))
    return fit
