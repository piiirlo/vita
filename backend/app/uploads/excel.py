"""Reading .xlsx files (openpyxl, read-only streaming mode).

Formulas are never evaluated: a cell gives its cached value (what Excel last computed), or
the formula as text ("=A1*2") when there is none. Cells become the same text the CSV reader
produces (numbers with a dot, dates as ISO), so one set of parsers handles both formats.
"""

import zipfile
from collections.abc import Iterator
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any, BinaryIO
from xml.etree.ElementTree import ParseError

from openpyxl import load_workbook

from app.uploads.reading import ReadError, Table

# An .xlsx is a zip. Its uncompressed size is checked before openpyxl opens it (a small
# file can unzip to gigabytes).
MAX_UNCOMPRESSED_RATIO = 100
MAX_UNCOMPRESSED_BYTES = 2 * 1024**3
MAX_ZIP_ENTRIES = 10_000


def is_xlsx(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as z:
            return "xl/workbook.xml" in z.namelist()
    except (zipfile.BadZipFile, OSError):
        return False


def check_zip(path: Path) -> None:
    """Refuse zip bombs and broken files (ReadError with the reason)."""
    try:
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
    except zipfile.BadZipFile:
        raise ReadError("This Excel file is damaged and can't be read.") from None
    total = sum(i.file_size for i in infos)
    size = max(path.stat().st_size, 1)
    if (
        len(infos) > MAX_ZIP_ENTRIES
        or total > MAX_UNCOMPRESSED_BYTES
        or total / size > MAX_UNCOMPRESSED_RATIO
    ):
        raise ReadError(
            "This Excel file unpacks to far more data than it holds; it can't be read safely."
        )


class _Workbook:
    """A read-only workbook opened from a file handle: uploads are stored without their
    extension, and openpyxl refuses a path that doesn't end in .xlsx."""

    def __init__(self, path: Path, data_only: bool) -> None:
        self.file: BinaryIO = path.open("rb")
        try:
            self.wb = load_workbook(self.file, read_only=True, data_only=data_only)
        except Exception:
            self.file.close()
            raise ReadError(
                "This Excel file is damaged or isn't a workbook; it can't be read."
            ) from None

    def close(self) -> None:
        self.wb.close()
        self.file.close()


def sheet_names(path: Path) -> list[str]:
    check_zip(path)
    book = _Workbook(path, data_only=True)
    try:
        return list(book.wb.sheetnames)
    finally:
        book.close()


def cell_text(value: Any) -> str:
    """A cell as the text the parsers read: 4.2 -> "4.2", 3.0 -> "3", a date -> "2024-03-15"."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return format(Decimal(repr(value)), "f") if abs(value) < 1e15 else repr(value)
    if isinstance(value, datetime):
        if value.time() == time(0) and value.tzinfo is None:
            return value.date().isoformat()
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    return str(value)


class SheetRows:
    """Rows of one sheet as text, with how far the reading got (import progress)."""

    def __init__(self, path: Path, sheet: str | None) -> None:
        check_zip(path)
        self.values_book = _Workbook(path, data_only=True)
        try:
            self.formulas_book = _Workbook(path, data_only=False)
        except ReadError:
            self.values_book.close()
            raise
        names = self.values_book.wb.sheetnames
        if sheet is not None and sheet not in names:
            self.close()
            raise ReadError(f'This workbook has no sheet named "{sheet}".')
        name = sheet if sheet is not None else names[0]
        self.values = self.values_book.wb[name]
        self.formulas = self.formulas_book.wb[name]
        self.total_rows = self.values.max_row or 0
        self.rows_read = 0

    def __iter__(self) -> Iterator[list[str]]:
        cached = self.values.iter_rows(values_only=True)
        raw = self.formulas.iter_rows(values_only=True)
        try:
            yield from self._rows(cached, raw)
        except (ParseError, zipfile.BadZipFile, KeyError, ValueError):
            raise ReadError("Part of this Excel file is damaged; it can't be read.") from None

    def _rows(
        self, cached: Iterator[tuple[Any, ...]], raw: Iterator[tuple[Any, ...]]
    ) -> Iterator[list[str]]:
        for values, formulas in zip(cached, raw, strict=False):
            self.rows_read += 1
            row = []
            for value, formula in zip(values, formulas, strict=False):
                if value is None and isinstance(formula, str) and formula.startswith("="):
                    row.append(formula)  # no cached value: the formula as text, never evaluated
                else:
                    row.append(cell_text(value))
            yield row

    def progress(self) -> float:
        return min(self.rows_read / self.total_rows, 1.0) if self.total_rows else 0.0

    def close(self) -> None:
        self.values_book.close()
        self.formulas_book.close()


def first_sheet_with_data(path: Path) -> str:
    """The first sheet that has a non-empty cell (workbooks often start with an empty one)."""
    names = sheet_names(path)
    for name in names:
        rows = SheetRows(path, name)
        try:
            for row, _ in zip(rows, range(50), strict=False):
                if any(cell.strip() for cell in row):
                    return name
        finally:
            rows.close()
    return names[0]


def read_sheet(rows: SheetRows, header: bool, skip_rows: int, sample: int = 200) -> Table:
    """Header + rows of a sheet, as wide as its widest of the first rows (trailing empty
    columns and fully empty rows are dropped)."""
    source = iter(rows)
    for _ in range(skip_rows):
        if next(source, None) is None:
            raise ReadError("The sheet has no rows.")
    head: list[list[str]] = []
    for row in source:
        head.append(row)
        if len(head) >= sample:
            break
    head = [r for r in head if any(c.strip() for c in r)]
    if not head:
        raise ReadError("The sheet is empty.")

    def used(row: list[str]) -> int:
        n = len(row)
        while n and not row[n - 1].strip():
            n -= 1
        return n

    width = max(used(r) for r in head)
    first, rest = head[0], head[1:]
    if header:
        headers = [c.strip() for c in (first + [""] * width)[:width]]
        buffered = rest
    else:
        headers = [f"column_{i + 1}" for i in range(width)]
        buffered = head

    def all_rows() -> Iterator[list[str]]:
        for row in buffered:
            yield (row + [""] * width)[:width]
        for row in source:
            if any(c.strip() for c in row):
                yield (row + [""] * width)[:width]

    return Table(headers=headers, rows=all_rows())
