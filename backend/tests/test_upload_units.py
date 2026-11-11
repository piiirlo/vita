"""File uploads without a database: detection, conversions, dates, names, the preview."""

from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from app.schemas.uploads import ReadOptionsIn
from app.uploads.names import clean_identifier, column_names, dataset_name_for, table_name_for
from app.uploads.preview import build_preview, detect_options
from app.uploads.reading import detect_delimiter, detect_encoding, detect_header, garbled_examples
from app.uploads.types import (
    ConvertError,
    NumberFormat,
    convert,
    date_orders,
    detect_number_format,
    guess_column,
    parse_datetime,
)

FRENCH_CSV = (
    "Produit;Prix TTC;Quantité;Date de vente;Payé\n"
    "Crème brûlée;4,20;3;15/03/2024;oui\n"
    "Café;1 234,50;12;16/03/2024;non\n"
    "Pâté;0,99;1;31/03/2024;oui\n"
)
ARABIC_CSV = "المنتج,السعر,المدينة\nتمر,12.5,الرياض\nقهوة,30,جدة\nشاي,7.25,القاهرة\n"


def write(tmp_path: Path, text: str | bytes, name: str = "f.csv") -> Path:
    path = tmp_path / name
    path.write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))
    return path


# ---------- detection ----------


def test_french_csv_semicolon_decimal_comma_and_dates(tmp_path: Path) -> None:
    path = write(tmp_path, FRENCH_CSV)
    options = detect_options(path)
    assert (options.encoding, options.delimiter, options.header) == ("utf-8", ";", True)
    assert (options.decimal, options.thousands) == (",", " ")
    preview = build_preview(path, options)
    cols = {c.source_name: c for c in preview.columns}
    assert [c.name for c in preview.columns] == [
        "produit",
        "prix_ttc",
        "quantite",
        "date_de_vente",
        "paye",
    ]
    assert cols["Prix TTC"].type == "decimal" and cols["Prix TTC"].misfits == 0
    assert cols["Quantité"].type == "integer"
    assert (cols["Date de vente"].type, cols["Date de vente"].date_order) == ("date", "dmy")
    assert cols["Payé"].type == "boolean"
    assert preview.rows[0] == ["Crème brûlée", "4,20", "3", "15/03/2024", "oui"]  # accents survive
    assert preview.problems == []


def test_arabic_utf8(tmp_path: Path) -> None:
    path = write(tmp_path, ARABIC_CSV)
    options = detect_options(path)
    assert (options.encoding, options.delimiter, options.decimal) == ("utf-8", ",", ".")
    preview = build_preview(path, options)
    assert [c.name for c in preview.columns] == ["المنتج", "السعر", "المدينة"]
    assert preview.columns[1].type == "decimal"
    assert preview.rows[2] == ["شاي", "7.25", "القاهرة"]
    assert garbled_examples(ARABIC_CSV) == []


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Prénom,Ville\nRené,Orléans\n".encode("utf-8-sig"), "utf-8-sig"),
        ("Prénom,Ville\nRené,Orléans\n".encode(), "utf-8"),
        ("Prénom,Note\nRené,“très bien” €\n".encode("windows-1252"), "windows-1252"),
        ("Prénom,Ville\nRené,Orléans\n".encode("iso-8859-1"), "iso-8859-1"),
    ],
)
def test_encodings(tmp_path: Path, raw: bytes, expected: str) -> None:
    assert detect_encoding(raw) == expected
    path = write(tmp_path, raw)
    preview = build_preview(path, detect_options(path))
    assert preview.rows[0][0] == "René"  # accents survive every encoding


def test_garbled_text_is_a_problem(tmp_path: Path) -> None:
    # UTF-8 bytes read as Windows-1252: "PrÃ©nom".
    path = write(tmp_path, "Prénom,Ville\nRené,Orléans\n".encode())
    options = detect_options(path).model_copy(update={"encoding": "windows-1252"})
    kinds = [p.kind for p in build_preview(path, options).problems]
    assert "garbled" in kinds


@pytest.mark.parametrize(
    ("text", "delimiter"),
    [
        ("a,b,c\n1,2,3\n4,5,6\n", ","),
        ("a;b;c\n1,5;2;3\n4;5;6\n", ";"),
        ("a\tb\tc\n1\t2\t3\n", "\t"),
        ("a|b|c\n1|2|3\n", "|"),
        ('name,note\n"Smith, J","a; b; c"\n"Doe, A","d; e"\n', ","),  # quoted delimiters
    ],
)
def test_delimiters(text: str, delimiter: str) -> None:
    assert detect_delimiter(text) == delimiter


def test_one_giant_column_means_the_wrong_delimiter(tmp_path: Path) -> None:
    path = write(tmp_path, FRENCH_CSV)
    options = detect_options(path).model_copy(update={"delimiter": ",", "columns": None})
    problems = build_preview(path, options).problems
    assert [p.kind for p in problems] == ["one_column"]
    assert "semicolons" in problems[0].message


def test_header_detection() -> None:
    assert detect_header([["name", "amount"], ["a", "1"], ["b", "2"]])
    assert not detect_header([["1", "2"], ["3", "4"], ["5", "6"]])


@pytest.mark.parametrize(
    ("values", "decimal", "thousands"),
    [
        (["4,20", "12,5", "3"], ",", ""),
        (["1.234,56", "12,00"], ",", "."),
        (["1,234.56", "12.00"], ".", ","),
        (["1 234,5", "12,25"], ",", " "),
        (["1'234.50", "7.5"], ".", "'"),
        (["4.20", "12.5", "3"], ".", ""),
        (["1,234", "5,678", "12"], ".", ","),  # ambiguous "1,234": thousands
    ],
)
def test_number_formats(values: list[str], decimal: str, thousands: str) -> None:
    assert detect_number_format(values) == NumberFormat(decimal, thousands)  # type: ignore[arg-type]


# ---------- conversions ----------

DOT = NumberFormat(".", "")
COMMA = NumberFormat(",", " ")


@pytest.mark.parametrize(
    ("text", "column_type", "fmt", "expected"),
    [
        ("  Bonjour ", "text", DOT, "  Bonjour "),
        ("NULL", "text", DOT, "NULL"),  # a word in a text column stays
        ("NULL", "integer", DOT, None),
        ("", "date", DOT, None),
        ("42", "integer", DOT, 42),
        ("-1,234", "integer", NumberFormat(".", ","), -1234),
        ("1 234", "integer", COMMA, 1234),
        ("4,20", "decimal", COMMA, Decimal("4.20")),
        ("1 234,5", "decimal", COMMA, Decimal("1234.5")),
        ("1.5e3", "decimal", DOT, Decimal("1.5E+3")),
        ("Oui", "boolean", DOT, True),
        ("false", "boolean", DOT, False),
        ("2024-03-15", "date", DOT, date(2024, 3, 15)),
        ("2024-03-15T10:30:00", "datetime", DOT, datetime(2024, 3, 15, 10, 30)),
        ("2024-03-15 10:30:00.250", "datetime", DOT, datetime(2024, 3, 15, 10, 30, 0, 250000)),
        ("2024-03-15T10:30:00+02:00", "datetime", DOT, datetime(2024, 3, 15, 8, 30)),
        ("2024-03-15", "datetime", DOT, datetime(2024, 3, 15)),
    ],
)
def test_conversions(text: str, column_type: str, fmt: NumberFormat, expected: object) -> None:
    assert convert(text, column_type, fmt, "ymd") == expected  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("text", "column_type", "fmt"),
    [
        ("4.2", "integer", DOT),
        ("12abc", "decimal", DOT),
        ("4.20", "decimal", COMMA),  # a dot where the decimal is a comma
        ("1,23", "integer", NumberFormat(".", ",")),  # not a thousands group
        ("9223372036854775808", "integer", DOT),  # over BIGINT
        ("maybe", "boolean", DOT),
        ("2024-02-30", "date", DOT),
        ("2024-03-15 25:00", "datetime", DOT),
    ],
)
def test_conversion_errors(text: str, column_type: str, fmt: NumberFormat) -> None:
    with pytest.raises(ConvertError):
        convert(text, column_type, fmt, "ymd")  # type: ignore[arg-type]


def test_date_orders() -> None:
    assert date_orders("2024-03-15") == {"ymd"}
    assert date_orders("15/03/2024") == {"dmy"}
    assert date_orders("03/15/2024") == {"mdy"}
    assert date_orders("03/04/2024") == {"dmy", "mdy"}  # ambiguous
    assert date_orders("hello") == set()
    assert convert("03/04/2024", "date", DOT, "dmy") == date(2024, 4, 3)
    assert convert("03/04/2024", "date", DOT, "mdy") == date(2024, 3, 4)
    assert parse_datetime("15.03.2024 08:05", "dmy") == datetime(2024, 3, 15, 8, 5)


def test_date_guesses_and_the_ambiguous_case() -> None:
    assert (
        guess_column(["15/03/2024", "01/02/2024"], DOT).date_order == "dmy"
    )  # 15 can only be a day
    assert guess_column(["03/15/2024", "01/02/2024"], DOT).date_order == "mdy"
    ambiguous = guess_column(["03/04/2024", "01/02/2024", "12/11/2023"], DOT)
    assert (ambiguous.type, ambiguous.date_order, ambiguous.date_ambiguous) == ("date", None, True)
    assert guess_column(["2024-03-15 10:00", "2024-03-16"], DOT).type == "datetime"


def test_ambiguous_dates_must_be_asked(tmp_path: Path) -> None:
    path = write(tmp_path, "day,amount\n03/04/2024,1\n01/02/2024,2\n12/11/2023,3\n")
    options = detect_options(path)
    preview = build_preview(path, options)
    [problem] = preview.problems
    assert (problem.kind, problem.blocking, problem.column) == ("ambiguous_date", True, 0)
    assert preview.columns[0].date_ambiguous
    # Picking the order clears it; the column still offers the choice.
    columns = [
        c.model_copy(update={"date_order": "dmy"} if c.index == 0 else {})
        for c in preview.options.columns or []
    ]
    answered = build_preview(path, options.model_copy(update={"columns": columns}))
    assert answered.problems == []
    assert answered.columns[0].date_ambiguous and answered.columns[0].date_order == "dmy"


def test_guessing_tolerates_a_few_bad_values_and_reports_them(tmp_path: Path) -> None:
    rows = "\n".join(f"{i},{i * 1.5}" for i in range(1, 60))
    path = write(tmp_path, f"id,amount\n{rows}\n60,n/a\n61,oops\n62,12abc\n63,???\n64,x\n")
    preview = build_preview(path, detect_options(path))
    amount = preview.columns[1]
    assert (amount.type, amount.misfits) == ("decimal", 4)  # "n/a" is empty, not a misfit
    assert [e.value for e in amount.examples] == ["oops", "12abc", "???", "x"]
    assert [e.row for e in amount.examples] == [61, 62, 63, 64]
    [problem] = preview.problems
    assert problem.kind == "misfit" and "4 of 64 values" in problem.message
    assert (60, 1) in preview.bad_cells  # row index 60 = data row 61


def test_user_types_and_ignored_columns_are_kept(tmp_path: Path) -> None:
    path = write(tmp_path, "id,amount\n1,10\n2,20\n")
    options = detect_options(path)
    first = build_preview(path, options)
    columns = [c.model_copy() for c in first.options.columns or []]
    columns[1] = columns[1].model_copy(update={"type": "text", "name": "montant"})
    columns[0] = columns[0].model_copy(update={"ignore": True})
    again = build_preview(path, options.model_copy(update={"columns": columns}))
    assert [(c.name, c.type, c.guessed_type, c.ignore) for c in again.columns] == [
        ("id", "integer", "integer", True),
        ("montant", "text", "integer", False),
    ]


def test_skip_rows_and_no_header(tmp_path: Path) -> None:
    path = write(tmp_path, "Report of March\nexported by X\nname,amount\na,1\nb,2\n")
    options = ReadOptionsIn(encoding="utf-8", delimiter=",", header=True, skip_rows=2)
    preview = build_preview(path, options)
    assert [c.name for c in preview.columns] == ["name", "amount"]
    assert preview.rows == [["a", "1"], ["b", "2"]]
    plain = build_preview(path, options.model_copy(update={"header": False, "skip_rows": 3}))
    assert [c.name for c in plain.columns] == ["column_1", "column_2"]
    assert plain.rows[0] == ["a", "1"]


def test_too_many_columns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "vita_upload_max_columns", 3)
    path = write(tmp_path, "a,b,c,d\n1,2,3,4\n")
    [problem] = build_preview(path, detect_options(path)).problems
    assert (problem.kind, problem.blocking) == ("too_many_columns", True)


# ---------- names ----------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Prix TTC (€)", "prix_ttc"),
        ("  Date de création ", "date_de_creation"),
        ("2024 sales", "_2024_sales"),
        ("select", "select_"),
        ("Order", "order_"),
        ("", "column_1"),
        ("---", "column_1"),
        ("المبلغ الكلي", "المبلغ_الكلي"),
        ("x" * 80, "x" * 63),
    ],
)
def test_clean_identifier(raw: str, expected: str) -> None:
    assert clean_identifier(raw, "column_1") == expected


def test_duplicates_and_file_names() -> None:
    assert column_names(["Name", "name", "NAME", "", "Name 2"]) == [
        "name",
        "name_2",
        "name_3",
        "column_4",
        "name_2_2",
    ]
    assert table_name_for("Ventes 2024 (final).csv") == "ventes_2024_final"
    assert table_name_for("2024.csv") == "_2024"
    assert dataset_name_for("Ventes 2024 (final).csv") == "Ventes 2024 (final)"
    assert dataset_name_for("data.tsv") == "data"


def test_a_header_without_rows_is_a_blocking_problem(tmp_path: Path) -> None:
    path = write(tmp_path, "name,amount\n")
    [problem] = build_preview(path, detect_options(path)).problems
    assert (problem.kind, problem.blocking) == ("no_rows", True)


# ---------- Excel cells ----------


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (None, ""),
        (True, "true"),
        (False, "false"),
        (42, "42"),
        (3.0, "3"),
        (4.2, "4.2"),
        (0.1 + 0.2, "0.30000000000000004"),
        (1e20, "1e+20"),
        (datetime(2024, 3, 15), "2024-03-15"),
        (datetime(2024, 3, 15, 9, 30), "2024-03-15 09:30:00"),
        (date(2024, 3, 15), "2024-03-15"),
        ("text", "text"),
    ],
)
def test_excel_cell_text(value: object, text: str) -> None:
    from app.uploads.excel import cell_text

    assert cell_text(value) == text


def test_excel_detection_and_damage(tmp_path: Path) -> None:
    import zipfile

    from app.uploads.excel import is_xlsx, sheet_names
    from app.uploads.reading import ReadError

    not_xlsx = tmp_path / "a.upload"
    with zipfile.ZipFile(not_xlsx, "w") as z:
        z.writestr("readme.txt", "hi")
    assert not is_xlsx(not_xlsx)
    broken = tmp_path / "b.upload"
    with zipfile.ZipFile(broken, "w") as z:
        z.writestr("xl/workbook.xml", "not xml")
    assert is_xlsx(broken)
    with pytest.raises(ReadError, match="damaged"):
        sheet_names(broken)
