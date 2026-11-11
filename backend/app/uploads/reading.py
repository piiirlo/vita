"""Reading delimited text files: encoding, delimiter and header detection, then rows.

Streaming with the standard csv module (constant memory): detection looks at the first
~256 KB; the import reads the whole file row by row.
"""

import codecs
import csv
import io
import re
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Literal

Encoding = Literal["utf-8", "utf-8-sig", "windows-1252", "iso-8859-1"]
ENCODINGS: tuple[Encoding, ...] = ("utf-8", "utf-8-sig", "windows-1252", "iso-8859-1")
DELIMITERS = (",", ";", "\t", "|")
SAMPLE_BYTES = 256 * 1024
SAMPLE_LINES = 200

# Text that was UTF-8 but read as Windows-1252 / Latin-1 ("Ã©" for "é", "â€™" for "’").
_MOJIBAKE = re.compile(r"Ã[\u0080-¿]|â€[\u0080-¿‘-„†-™]|Â[ -¿]")

csv.field_size_limit(16 * 1024 * 1024)


class ReadError(Exception):
    """The file can't be read as delimited text (message is shown to the user)."""


@dataclass(frozen=True)
class ReadOptions:
    encoding: Encoding = "utf-8"
    delimiter: str = ","
    header: bool = True
    skip_rows: int = 0


def detect_encoding(head: bytes) -> Encoding:
    """BOM -> UTF-8 with BOM; valid UTF-8 -> UTF-8 (Arabic, accents...); else Windows-1252
    when bytes 0x80-0x9F appear (curly quotes, €: unused in Latin-1), else ISO-8859-1."""
    if head.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        decoder.decode(head, final=False)  # a character cut at the end of the sample is fine
        return "utf-8"
    except UnicodeDecodeError:
        pass
    if any(0x80 <= b <= 0x9F for b in head):
        return "windows-1252"
    return "iso-8859-1"


def looks_binary(head: bytes) -> bool:
    return b"\x00" in head[:8192]


def sample_text(path: Path, encoding: Encoding) -> str:
    """The start of the file as text, cut at the last complete line."""
    with path.open("rb") as f:
        head = f.read(SAMPLE_BYTES)
        more = bool(f.read(1))
    text = head.decode(encoding, errors="replace")
    if more and "\n" in text:
        text = text[: text.rfind("\n") + 1]
    return text


def detect_delimiter(text: str) -> str:
    """The delimiter that splits the sample into the most columns, consistently."""
    lines = [line for line in text.splitlines()[:SAMPLE_LINES] if line.strip()]
    if not lines:
        return ","
    best, best_score = ",", 0.0
    for delimiter in DELIMITERS:
        counts = [
            len(row) for row in csv.reader(io.StringIO("\n".join(lines)), delimiter=delimiter)
        ]
        if not counts:
            continue
        width, hits = Counter(counts).most_common(1)[0]
        if width < 2:
            continue
        # Mostly the same number of cells per row, and more of them, is better.
        score = (hits / len(counts)) * (1 + min(width, 50) / 50)
        if score > best_score:
            best, best_score = delimiter, score
    return best


_NUMBERISH = re.compile(r"^[\s+-]?[\d.,\s'%€$£-]*\d[\d.,\s'%€$£-]*$")


def detect_header(rows: list[list[str]]) -> bool:
    """A first row of labels over rows of numbers / dates is a header. If the first row has
    numbers where later rows do too, it's data. Default: a header."""
    if len(rows) < 2:
        return True
    first, rest = rows[0], rows[1:]
    for i, cell in enumerate(first):
        column = [r[i] for r in rest if i < len(r) and r[i].strip()]
        if not column:
            continue
        numeric_below = sum(bool(_NUMBERISH.match(v)) for v in column) / len(column)
        if numeric_below > 0.8 and _NUMBERISH.match(cell.strip() or "x"):
            return False
    return True


def garbled_examples(text: str, limit: int = 3) -> list[str]:
    """Words that look like mis-decoded text ("PrÃ©nom") or replacement characters."""
    found = []
    for match in re.finditer(r"\S*(?:Ã[\u0080-¿]|â€.|Â[ -¿]|�)\S*", text):
        if match.group(0) not in found:
            found.append(match.group(0)[:40])
        if len(found) >= limit:
            break
    return found


class CountingReader(io.RawIOBase):
    """Wraps a binary file and counts the bytes read (import progress)."""

    def __init__(self, raw: BinaryIO) -> None:
        self.raw = raw
        self.bytes_read = 0

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: bytearray | memoryview) -> int:  # type: ignore[override]
        data = self.raw.read(len(buffer))
        n = len(data)
        buffer[:n] = data
        self.bytes_read += n
        return n


@dataclass
class Table:
    headers: list[str]
    rows: Iterator[list[str]]
    # Rows whose cell count didn't match the header (extra cells are dropped, missing empty).
    ragged: list[int] = field(default_factory=list)


def read_table(raw: BinaryIO, options: ReadOptions) -> Table:
    """Header + an iterator of rows, every row as wide as the header. `raw` is consumed."""
    text = io.TextIOWrapper(raw, encoding=options.encoding, errors="replace", newline="")
    reader = csv.reader(text, delimiter=options.delimiter)
    try:
        for _ in range(options.skip_rows):
            next(reader)
        first = next(reader)
    except StopIteration:
        raise ReadError("The file has no rows.") from None
    if options.header:
        headers = [h.strip() for h in first]
        pending: list[list[str]] = []
    else:
        headers = [f"column_{i + 1}" for i in range(len(first))]
        pending = [first]
    width = len(headers)
    table = Table(headers=headers, rows=iter(()))

    def rows() -> Iterator[list[str]]:
        line = options.skip_rows + (1 if options.header else 0)
        for row in [*pending]:
            line += 1
            yield _fit(row, width, line, table)
        for row in reader:
            line += 1
            if not row or (len(row) == 1 and not row[0].strip()):
                continue  # blank line
            yield _fit(row, width, line, table)

    table.rows = rows()
    return table


def _fit(row: list[str], width: int, line: int, table: Table) -> list[str]:
    if len(row) != width:
        if len(table.ragged) < 1000:
            table.ragged.append(line)
        return (row + [""] * width)[:width]
    return row
