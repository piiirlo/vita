"""Safe table and column names for uploaded files.

Names are still always quoted when used (psycopg sql.Identifier / sqlglot): cleaning is for
readable, typeable names, not for safety. Latin accents are removed ("Prénom" -> "prenom");
other letters are kept ("المبلغ" stays), anything else becomes "_".
"""

import re
import unicodedata

# Postgres caps identifiers at 63 bytes.
MAX_IDENTIFIER_BYTES = 63

# SQL reserved words (Postgres + the SQL standard ones people hit in CSV headers). A column
# with one of these names gets a trailing "_" so it can be typed in SQL without quotes.
RESERVED = frozenset(
    """
    all analyse analyze and any array as asc asymmetric authorization between binary both case
    cast check collate column concurrently constraint create cross current_catalog current_date
    current_role current_schema current_time current_timestamp current_user default deferrable
    desc distinct do else end except false fetch for foreign freeze from full grant group having
    ilike in initially inner intersect into is isnull join lateral leading left like limit
    localtime localtimestamp natural not notnull null offset on only or order outer overlaps
    placing primary references returning right select session_user similar some symmetric table
    tablesample then to trailing true union unique user using variadic verbose when where window
    with
    """.split()  # noqa: SIM905 - a word list reads better than 100 quoted strings
)


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    # Drop combining marks of Latin letters only (keeps Arabic vowel marks etc. readable).
    out: list[str] = []
    for ch in decomposed:
        if unicodedata.combining(ch) and out and out[-1].isascii():
            continue
        out.append(ch)
    return unicodedata.normalize("NFC", "".join(out))


def _truncate(name: str, limit: int = MAX_IDENTIFIER_BYTES) -> str:
    if len(name.encode()) <= limit:
        return name
    while len(name.encode()) > limit:
        name = name[:-1]
    return name.rstrip("_") or name  # don't end a cut name with "_"


def clean_identifier(raw: str, fallback: str) -> str:
    """'Prix TTC (€)' -> 'prix_ttc', '2024 sales' -> '_2024_sales', 'select' -> 'select_'."""
    text = _strip_accents(raw).lower()
    text = re.sub(r"[^\w]+", "_", text, flags=re.UNICODE)
    text = re.sub(r"_+", "_", text).strip("_")
    if not text:
        text = fallback
    if text[0].isdigit():
        text = "_" + text
    if text in RESERVED:
        text += "_"
    return _truncate(text)


def unique_names(names: list[str]) -> list[str]:
    """Make every name unique by adding _2, _3... (case-insensitive, within 63 bytes)."""
    seen: set[str] = set()
    out = []
    for name in names:
        candidate = name
        n = 2
        while candidate.lower() in seen:
            suffix = f"_{n}"
            candidate = _truncate(name, MAX_IDENTIFIER_BYTES - len(suffix)) + suffix
            n += 1
        seen.add(candidate.lower())
        out.append(candidate)
    return out


def column_names(headers: list[str]) -> list[str]:
    """Clean header cells into unique column names (empty headers: column_1, column_2...)."""
    return unique_names([clean_identifier(h, f"column_{i + 1}") for i, h in enumerate(headers)])


def table_name_for(file_name: str) -> str:
    """'Ventes 2024 (final).csv' -> 'ventes_2024_final' (at most 50 bytes: room for _2...)."""
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", file_name.strip())
    return _truncate(clean_identifier(stem, "upload"), 50)


def dataset_name_for(file_name: str) -> str:
    """The file name without its extension, as typed: 'Ventes 2024.csv' -> 'Ventes 2024'."""
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", file_name.strip())
    return (stem.strip() or "Upload")[:200]
