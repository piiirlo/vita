"""Filters -> sqlglot conditions. Values always become sqlglot literals after Python has
checked them against the column's type, so a filter value can never become SQL."""

from datetime import date, datetime
from typing import NoReturn

from sqlglot import exp

from app.models import DatasetColumn
from app.query import QueryError
from app.schemas.charts import Filter, FilterValue, Scalar

NUMERIC_OR_TEMPORAL = {"number", "date", "datetime"}

# Which operators make sense for which (effective) column type.
_COMPARISON = {">", ">=", "<", "<=", "BETWEEN"}
_ALWAYS = {"=", "!=", "IN", "NOT IN", "IS NULL", "IS NOT NULL"}
ALLOWED_OPERATORS: dict[str, set[str]] = {
    "number": _ALWAYS | _COMPARISON,
    "date": _ALWAYS | _COMPARISON,
    "datetime": _ALWAYS | _COMPARISON,
    "string": _ALWAYS | {"LIKE"},
    "boolean": {"=", "!=", "IS NULL", "IS NOT NULL"},
    "other": {"=", "!=", "IS NULL", "IS NOT NULL"},
}


def _invalid(message: str) -> NoReturn:
    raise QueryError("invalid", message)


def date_literal(value: date) -> exp.Expr:
    return exp.cast(exp.Literal.string(value.isoformat()), exp.DataType.build("DATE"))


def _literal(value: Scalar, column: DatasetColumn) -> exp.Expr:
    """One value as a literal of the column's type."""
    kind = column.effective_type
    name = column.name
    if kind == "number":
        if isinstance(value, bool):
            _invalid(f'"{name}" is a number column; {value!r} is not a number.')
        if isinstance(value, (int, float)):
            return exp.Literal.number(value)
        text = str(value).strip()
        try:
            number: int | float = int(text)
        except ValueError:
            try:
                number = float(text)
            except ValueError:
                _invalid(f'"{name}" is a number column; "{value}" is not a number.')
        return exp.Literal.number(number)
    if kind == "date" or kind == "datetime":
        try:
            parsed = datetime.fromisoformat(str(value).strip())
        except ValueError:
            _invalid(f'"{name}" is a {kind} column; "{value}" is not a date (use YYYY-MM-DD).')
        if kind == "date":
            return date_literal(parsed.date())
        return exp.cast(
            exp.Literal.string(parsed.isoformat(sep=" ")), exp.DataType.build("DATETIME")
        )
    if kind == "boolean":
        if isinstance(value, bool):
            return exp.true() if value else exp.false()
        text = str(value).strip().lower()
        if text in {"true", "1", "yes"}:
            return exp.true()
        if text in {"false", "0", "no"}:
            return exp.false()
        _invalid(f'"{name}" is a true/false column; "{value}" is not true or false.')
    return exp.Literal.string(str(value))


def _one(value: FilterValue, f: Filter) -> Scalar:
    if value is None or isinstance(value, list):
        _invalid(f'The {f.operator} filter on "{f.column}" needs a single value.')
    if isinstance(value, str) and value == "":
        _invalid(f'The {f.operator} filter on "{f.column}" needs a value.')
    return value


def _like_pattern(value: Scalar) -> str:
    """'contains' pattern: wildcards in the value are matched literally."""
    text = str(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{text}%"


def filter_condition(f: Filter, column: DatasetColumn, ref: exp.Expr) -> exp.Expr:
    kind = column.effective_type
    op = f.operator
    if op not in ALLOWED_OPERATORS.get(kind, ALLOWED_OPERATORS["other"]):
        _invalid(f'The {op} operator doesn\'t work on "{f.column}" ({kind} column).')

    if op in {"IS NULL", "IS NOT NULL"}:
        if f.value not in (None, [], ""):
            _invalid(f'The {op} filter on "{f.column}" takes no value.')
        is_null = exp.Is(this=ref.copy(), expression=exp.Null())
        return is_null if op == "IS NULL" else exp.Not(this=is_null)

    if op in {"IN", "NOT IN"}:
        values = f.value if isinstance(f.value, list) else None
        if not values:
            _invalid(f'The {op} filter on "{f.column}" needs a list with at least one value.')
        has_null = any(v is None for v in values)
        literals = [_literal(v, column) for v in values if v is not None]
        is_null = exp.Is(this=ref.copy(), expression=exp.Null())
        if op == "IN":
            # IN [x, null]: x or empty.
            if not literals:
                return is_null
            matches = exp.In(this=ref.copy(), expressions=literals)
            return exp.Paren(this=exp.or_(matches, is_null)) if has_null else matches
        # NOT IN: "everything except these" keeps empty values, unless null is in the list.
        if not literals:
            return exp.Not(this=is_null)
        excluded = exp.Not(this=exp.In(this=ref.copy(), expressions=literals))
        if has_null:
            return exp.and_(excluded, exp.Not(this=is_null.copy()))
        return exp.Paren(this=exp.or_(is_null, excluded))

    if op == "BETWEEN":
        if not (isinstance(f.value, list) and len(f.value) == 2):
            _invalid(f'The BETWEEN filter on "{f.column}" needs two values: [low, high].')
        low, high = f.value
        if low is None or high is None:
            _invalid(f'The BETWEEN filter on "{f.column}" needs two values: [low, high].')
        return exp.Between(this=ref.copy(), low=_literal(low, column), high=_literal(high, column))

    value = _one(f.value, f)
    if op == "LIKE":  # "contains", case-insensitive (MySQL: LOWER(..) LIKE LOWER(..))
        return exp.ILike(this=ref.copy(), expression=exp.Literal.string(_like_pattern(value)))

    literal = _literal(value, column)
    if op == "!=":
        # "everything except X" keeps empty values (plain <> would drop NULL rows).
        return exp.Paren(
            this=exp.or_(
                exp.Is(this=ref.copy(), expression=exp.Null()),
                exp.NEQ(this=ref.copy(), expression=literal),
            )
        )
    node = {
        "=": exp.EQ, "!=": exp.NEQ, ">": exp.GT, ">=": exp.GTE, "<": exp.LT, "<=": exp.LTE,
    }[op]  # fmt: skip
    return node(this=ref.copy(), expression=literal)
