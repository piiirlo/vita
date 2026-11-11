"""Detecting how a file is read, and the preview: columns, first rows, problems.

CSV / TSV and Excel files go through the same steps after reading (`open_source`). When a
file replaces or appends to a dataset's table (`target`), its columns are matched to the
table's by name, matched columns keep the table's type, and anything missing is a problem.
"""

import io
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.config import settings
from app.schemas.uploads import CellExample, ColumnOption, ColumnPreview, Problem, ReadOptionsIn
from app.uploads.excel import SheetRows, first_sheet_with_data, read_sheet
from app.uploads.names import column_names
from app.uploads.reading import (
    DELIMITERS,
    CountingReader,
    ReadError,
    ReadOptions,
    Table,
    detect_delimiter,
    detect_encoding,
    detect_header,
    garbled_examples,
    read_table,
    sample_text,
)
from app.uploads.types import (
    ColumnType,
    NumberFormat,
    check_fit,
    detect_number_format,
    guess_column,
)

SAMPLE_ROWS = 10_000
PREVIEW_ROWS = 100
# A column's misfits are a problem (the adjust panel opens) from this share of its values,
# or from this many values.
MISFIT_SHARE = 0.01
MISFIT_COUNT = 5
DELIMITER_NAMES = {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe"}

FileKind = Literal["csv", "xlsx"]
Mode = Literal["create", "replace", "append"]
# The columns of the table a file replaces / appends to: (name, type), in table order.
Target = list[tuple[str, ColumnType]]


def read_options(options: ReadOptionsIn) -> ReadOptions:
    return ReadOptions(
        encoding=options.encoding,
        delimiter=options.delimiter,
        header=options.header,
        skip_rows=options.skip_rows,
    )


def number_format(options: ReadOptionsIn) -> NumberFormat:
    return NumberFormat(options.decimal, options.thousands)


@contextmanager
def open_source(
    path: Path, kind: FileKind, options: ReadOptionsIn
) -> Iterator[tuple[Table, Callable[[], float]]]:
    """The file's header + rows, and how far the reading got (0..1)."""
    if kind == "xlsx":
        rows = SheetRows(path, options.sheet)
        try:
            yield read_sheet(rows, options.header, options.skip_rows), rows.progress
        finally:
            rows.close()
        return
    size = max(path.stat().st_size, 1)
    with path.open("rb") as raw:
        counter = CountingReader(raw)
        yield read_table(counter, read_options(options)), lambda: counter.bytes_read / size  # type: ignore[arg-type]


def detect_options(path: Path, kind: FileKind = "csv") -> ReadOptionsIn:
    """Everything detected: encoding, delimiter (or sheet), header, number format."""
    if kind == "xlsx":
        sheet = first_sheet_with_data(path)
        sheet_rows = SheetRows(path, sheet)
        try:
            head = [
                r for _, r in zip(range(200), read_sheet(sheet_rows, False, 0).rows, strict=False)
            ]
        finally:
            sheet_rows.close()
        # Excel cells are typed: numbers come with a dot, dates as ISO.
        return ReadOptionsIn(
            encoding="utf-8", delimiter=",", header=detect_header(head), sheet=sheet
        )
    with path.open("rb") as f:
        head_bytes = f.read(64 * 1024)
    encoding = detect_encoding(head_bytes)
    text = sample_text(path, encoding)
    delimiter = detect_delimiter(text)
    with path.open("rb") as f:
        sample = read_table(f, ReadOptions(encoding=encoding, delimiter=delimiter, header=False))
        rows = [r for _, r in zip(range(200), sample.rows, strict=False)]
    header = detect_header(rows)
    values = [cell for row in rows[1 if header else 0 :] for cell in row]
    fmt = detect_number_format(values)
    return ReadOptionsIn(
        encoding=encoding,
        delimiter=delimiter,
        header=header,
        decimal=fmt.decimal,
        thousands=fmt.thousands,
    )


@dataclass
class Preview:
    options: ReadOptionsIn  # with the columns filled in
    columns: list[ColumnPreview]
    rows: list[list[str | None]]
    bad_cells: list[tuple[int, int]]
    problems: list[Problem]
    sampled_rows: int
    more_rows: bool
    # Replace / append: the table's columns the file doesn't have.
    missing_columns: list[str] = field(default_factory=list)


def _match_target(
    given: list[ColumnOption], target: Target, mode: Mode, fresh: bool
) -> tuple[list[ColumnOption], dict[int, str]]:
    """Columns matched to the table by name keep its name and type. Fresh guesses: other
    columns are left out when appending (the table has no place for them)."""
    by_name = {name.lower(): (name, column_type) for name, column_type in target}
    out: list[ColumnOption] = []
    status: dict[int, str] = {}
    for col in given:
        hit = by_name.get(col.name.strip().lower())
        if hit:
            name, column_type = hit
            keep_order = col.date_order if column_type in ("date", "datetime") else None
            out.append(
                col.model_copy(update={"name": name, "type": column_type, "date_order": keep_order})
            )
            status[col.index] = "matched"
        else:
            ignore = col.ignore or (fresh and mode == "append")
            out.append(col.model_copy(update={"ignore": ignore}))
            status[col.index] = "new" if mode == "replace" else "extra"
    return out, status


def build_preview(
    path: Path,
    options: ReadOptionsIn,
    kind: FileKind = "csv",
    target: Target | None = None,
    mode: Mode = "create",
) -> Preview:
    """Read the start of the file with `options`; guess or apply the column settings."""
    with open_source(path, kind, options) as (table, _):
        sample = [row for _, row in zip(range(SAMPLE_ROWS), table.rows, strict=False)]
        more_rows = next(table.rows, None) is not None
    headers = table.headers
    problems: list[Problem] = []
    if len(headers) > settings.vita_upload_max_columns:
        problems.append(
            Problem(
                kind="too_many_columns",
                message=f"The file has {len(headers):,} columns; at most "
                f"{settings.vita_upload_max_columns:,} can be imported.",
                blocking=True,
            )
        )
        return Preview(options, [], [], [], problems, len(sample), more_rows)

    fmt = number_format(options)
    guesses = [guess_column([row[i] for row in sample], fmt) for i in range(len(headers))]
    given = options.columns if options.columns and len(options.columns) == len(headers) else None
    fresh = given is None
    if given is None:
        names = column_names(headers)
        given = [
            ColumnOption(index=i, name=names[i], type=g.type, date_order=g.date_order)
            for i, g in enumerate(guesses)
        ]
    status: dict[int, str] = {}
    missing: list[str] = []
    if target is not None:
        given, status = _match_target(given, target, mode, fresh)
        kept = {c.name.lower() for c in given if not c.ignore}
        missing = [name for name, _ in target if name.lower() not in kept]
    effective = options.model_copy(update={"columns": given})

    columns: list[ColumnPreview] = []
    bad_cells: list[tuple[int, int]] = []
    for i, (col, guess) in enumerate(zip(given, guesses, strict=True)):
        is_date = col.type in ("date", "datetime")
        # A date column's order: the user's, else the guess when it isn't ambiguous.
        order = col.date_order if is_date else None
        if is_date and order is None and not guess.date_ambiguous:
            order = guess.date_order or "ymd"
        ambiguous = is_date and order is None
        fit = check_fit([(n + 1, row[i]) for n, row in enumerate(sample)], col.type, fmt, order)
        checked = sum(1 for row in sample if row[i] and row[i].strip())
        columns.append(
            ColumnPreview(
                index=i,
                source_name=headers[i],
                name=col.name,
                type=col.type,
                guessed_type=guess.type,
                ignore=col.ignore,
                date_order=order,
                date_ambiguous=ambiguous or (guess.date_ambiguous and is_date),
                checked=checked,
                misfits=fit.misfits,
                examples=[CellExample(row=r, value=v[:80]) for r, v in fit.examples],
                locked=status.get(i) == "matched",
                status=status.get(i),
            )
        )
        if order is not None and is_date:
            given[i] = col.model_copy(update={"date_order": order})
        if fit.misfits:
            bad_rows = {
                r
                for r, _ in check_fit(
                    [(n + 1, row[i]) for n, row in enumerate(sample[:PREVIEW_ROWS])],
                    col.type,
                    fmt,
                    order,
                    examples=PREVIEW_ROWS,
                ).examples
            }
            bad_cells.extend((r - 1, i) for r in sorted(bad_rows))
        if col.ignore:
            continue
        if ambiguous:
            problems.append(
                Problem(
                    kind="ambiguous_date",
                    column=i,
                    message=f'"{headers[i]}": dates like {_first(sample, i)} read both as '
                    "day/month and month/day. Pick the order.",
                    examples=_values(sample, i)[:3],
                    blocking=True,
                )
            )
        elif fit.misfits and (
            fit.misfits >= MISFIT_COUNT or fit.misfits / max(checked, 1) >= MISFIT_SHARE
        ):
            problems.append(
                Problem(
                    kind="misfit",
                    column=i,
                    message=f'"{headers[i]}": {fit.misfits:,} of {checked:,} values aren\'t a '
                    f"valid {col.type} (they'd be empty). Change the type, or the decimal / "
                    "date settings.",
                    examples=[v for _, v in fit.examples],
                )
            )
    effective = options.model_copy(update={"columns": given})

    if target is not None:
        problems.extend(_target_problems(given, status, missing, mode))
    if not sample:
        problems.append(
            Problem(
                kind="no_rows",
                message="There are no rows under the header. Check "
                "“First row is the header” and the rows to skip.",
                blocking=True,
            )
        )
    if all(c.ignore for c in given):
        problems.append(
            Problem(kind="no_columns", message="Every column is left out.", blocking=True)
        )
    if kind == "csv":
        problems.extend(_text_problems(path, options, headers))
    # (With everything in one column, the "one column" problem already says why.)
    one_column = any(p.kind == "one_column" for p in problems)
    if table.ragged and not one_column and len(table.ragged) > max(1, len(sample) // 100):
        lines = ", ".join(str(n) for n in table.ragged[:5])
        problems.append(
            Problem(
                kind="ragged",
                message=f"{len(table.ragged):,} rows don't have {len(headers)} cells "
                f"(lines {lines}…): check the delimiter and the rows to skip.",
            )
        )

    rows: list[list[str | None]] = [list(row) for row in sample[:PREVIEW_ROWS]]
    return Preview(effective, columns, rows, bad_cells, problems, len(sample), more_rows, missing)


def _target_problems(
    given: list[ColumnOption], status: dict[int, str], missing: list[str], mode: Mode
) -> list[Problem]:
    problems = []
    if missing:
        why = (
            "charts, metrics and filters may use them"
            if mode == "replace"
            else "every row needs them"
        )
        problems.append(
            Problem(
                kind="columns_mismatch",
                message=f"The file has no column for {_names(missing)} ({why}). Rename a "
                "column to match, or check the header row.",
                examples=missing,
                blocking=True,
            )
        )
    extra = [c.name for c in given if not c.ignore and status.get(c.index) in ("extra", "new")]
    if extra and mode == "append":
        problems.append(
            Problem(
                kind="columns_mismatch",
                message=f"The dataset's table has no column {_names(extra)}. Leave "
                f"{'it' if len(extra) == 1 else 'them'} out, or rename to match.",
                examples=extra,
                blocking=True,
            )
        )
    elif extra:
        problems.append(
            Problem(
                kind="columns_mismatch",
                message=f"New {'column' if len(extra) == 1 else 'columns'} {_names(extra)} will "
                "be added to the dataset.",
                examples=extra,
            )
        )
    return problems


def _names(names: list[str]) -> str:
    quoted = [f"“{n}”" for n in names[:8]]
    more = f" and {len(names) - 8} more" if len(names) > 8 else ""
    return ", ".join(quoted) + more


def _text_problems(path: Path, options: ReadOptionsIn, headers: list[str]) -> list[Problem]:
    problems = []
    if len(headers) == 1:
        others = [d for d in DELIMITERS if d != options.delimiter and d in headers[0]]
        if others:
            problems.append(
                Problem(
                    kind="one_column",
                    message="Everything is in one column: the file is probably separated by "
                    f"{DELIMITER_NAMES[others[0]]}s. Change the delimiter.",
                    examples=[headers[0][:80]],
                )
            )
    garbled = garbled_examples(_head_text(path, options))
    if garbled:
        problems.append(
            Problem(
                kind="garbled",
                message="Some text looks garbled, e.g. "
                + ", ".join(f"“{g}”" for g in garbled)
                + ". Try another encoding.",
                examples=garbled,
            )
        )
    return problems


def _values(sample: list[list[str]], i: int) -> list[str]:
    return [row[i] for row in sample if row[i].strip()]


def _first(sample: list[list[str]], i: int) -> str:
    values = _values(sample, i)
    return values[0] if values else ""


def _head_text(path: Path, options: ReadOptionsIn) -> str:
    with path.open("rb") as f:
        return io.TextIOWrapper(
            io.BytesIO(f.read(64 * 1024)), encoding=options.encoding, errors="replace"
        ).read()


__all__ = ["Preview", "ReadError", "Target", "build_preview", "detect_options", "open_source"]
