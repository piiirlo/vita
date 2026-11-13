"""File uploads: how a file is read (options), the preview, and the import job."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.uploads.reading import Encoding
from app.uploads.types import ColumnType, DateOrder, Decimal_, Thousands

Delimiter = Literal[",", ";", "\t", "|"]
UploadStatus = Literal["pending", "importing", "done", "failed", "cancelled", "expired"]


class ColumnOption(BaseModel):
    """One column of the file: its name in the table, its type, or left out."""

    index: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=63)
    type: ColumnType
    ignore: bool = False
    # Dates: the order of day / month (ymd for 2024-03-15). Required when ambiguous.
    date_order: DateOrder | None = None


class ReadOptionsIn(BaseModel):
    encoding: Encoding
    delimiter: Delimiter
    header: bool = True
    skip_rows: int = Field(default=0, ge=0, le=1000)
    decimal: Decimal_ = "."
    thousands: Thousands = ""
    # Excel: the sheet to read (None: the first one with data).
    sheet: str | None = Field(default=None, max_length=255)
    # None: guess the columns again (after the delimiter / header / encoding changed).
    columns: list[ColumnOption] | None = None


class ImportIn(BaseModel):
    options: ReadOptionsIn
    dataset_name: str = Field(min_length=1, max_length=200)
    # Values that don't fit their column's type: NULL (and reported), or stop the import.
    on_error: Literal["null", "stop"] = "null"


class CellExample(BaseModel):
    row: int  # data row number (1 = the first row after the header)
    value: str


class ColumnPreview(BaseModel):
    index: int
    source_name: str  # the header as in the file
    name: str
    type: ColumnType
    guessed_type: ColumnType
    ignore: bool
    date_order: DateOrder | None = None
    # Every date reads both ways (03/04/2024): the user must pick the order.
    date_ambiguous: bool = False
    checked: int  # non-empty values looked at
    misfits: int  # ...that don't fit the type (they become NULL)
    examples: list[CellExample] = Field(default_factory=list)
    # Replace / append: the column matches one of the dataset's table (its type is kept),
    # is new (replace adds it) or extra (append can't take it: leave it out or rename it).
    locked: bool = False
    status: Literal["matched", "new", "extra"] | None = None
    # Values like "N/A" / "null" that become empty (non-text columns only).
    null_words: int = 0
    # Whole numbers all between 1900 and 2100: "name" = also a year-like name (it becomes a
    # year time column), "values" = only the values (the Columns tab suggests it).
    years: Literal["name", "values"] | None = None


class Problem(BaseModel):
    kind: Literal[
        "misfit",
        "garbled",
        "one_column",
        "ambiguous_date",
        "ragged",
        "too_many_columns",
        "no_columns",
        "no_rows",
        "columns_mismatch",
    ]
    message: str
    column: int | None = None
    examples: list[str] = Field(default_factory=list)
    # Blocking problems disable "Create dataset" until fixed.
    blocking: bool = False


class TargetDataset(BaseModel):
    """The dataset a file replaces the data of, or appends rows to."""

    id: int
    name: str
    table_name: str


class UploadPreview(BaseModel):
    upload_id: int
    file_name: str
    file_size: int
    file_kind: Literal["csv", "xlsx"]
    sheets: list[str] = Field(default_factory=list)  # Excel: every sheet, to pick one
    mode: Literal["create", "replace", "append"] = "create"
    target: TargetDataset | None = None
    missing_columns: list[str] = Field(default_factory=list)
    dataset_name: str
    options: ReadOptionsIn
    detected: ReadOptionsIn
    columns: list[ColumnPreview]
    rows: list[list[str | None]]  # the first 100 data rows, as read (all columns)
    bad_cells: list[tuple[int, int]]  # (row index in `rows`, column index) that don't fit
    problems: list[Problem]
    sampled_rows: int  # rows looked at to guess the types
    more_rows: bool  # the file has more rows than were sampled


class BadValues(BaseModel):
    column: str
    count: int
    examples: list[CellExample]
    # misfit: didn't fit the column's type; null_word: "N/A", "null"... read as empty.
    kind: Literal["misfit", "null_word"] = "misfit"


class UploadOut(BaseModel):
    """An upload (and its import job)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    file_name: str
    file_size: int
    status: UploadStatus
    mode: Literal["create", "replace", "append"]
    progress: float  # 0..1 of the file read
    rows_done: int
    row_count: int | None
    table_name: str | None
    dataset_id: int | None
    error: str | None
    bad_values: list[BadValues]
    created_at: datetime
    finished_at: datetime | None
