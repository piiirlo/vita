"""Check SQL with sqlglot before it reaches the database.

- exactly one statement (a trailing semicolon is fine)
- read queries only: SELECT / WITH / UNION / VALUES, SHOW, DESCRIBE, EXPLAIN
- MySQL: cap the outermost LIMIT at limit + 1 (see runner.py for why)

The database also runs every query in a read-only transaction; this check is the
first layer and gives clearer messages.
"""

import logging
import re
from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, TokenError
from sqlglot.tokenizer_core import TokenType

from app.query.errors import QueryError, read_only_error

# sqlglot logs a warning for every statement it parses as a generic Command.
logging.getLogger("sqlglot").setLevel(logging.ERROR)

DIALECTS = {"postgresql": "postgres", "mysql": "mysql"}

# Statement types that change data, schema, permissions, or transactions.
_WRITE_NODE_NAMES = (
    "Insert", "Update", "Delete", "Merge", "Create", "Drop", "TruncateTable", "Alter",
    "Copy", "Grant", "Revoke", "Comment", "Commit", "Rollback", "Transaction", "Execute",
    "Analyze", "Kill", "Refresh", "LoadData", "Attach", "Detach", "Set", "Use", "Lock",
)  # fmt: skip
WRITE_NODES: tuple[type[exp.Expr], ...] = tuple(
    getattr(exp, name) for name in _WRITE_NODE_NAMES if hasattr(exp, name)
)

_WRITE_WORDS = {
    "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "DROP", "TRUNCATE", "ALTER", "COPY",
    "GRANT", "REVOKE", "COMMENT", "REPLACE", "RENAME", "VACUUM", "REINDEX", "CLUSTER",
    "REFRESH", "LOCK", "LOAD", "IMPORT", "CALL", "DO", "OPTIMIZE", "REPAIR", "FLUSH",
    "RESET", "DISCARD", "NOTIFY", "LISTEN", "SECURITY", "REASSIGN", "HANDLER",
}  # fmt: skip
_ALLOWED_COMMANDS = {"SHOW", "DESCRIBE", "DESC", "EXPLAIN"}
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_EXPLAIN_OPTIONS = re.compile(
    r"^\s*(\([^)]*\)|ANALY[SZ]E|VERBOSE|EXTENDED|PARTITIONS|FORMAT\s*=?\s*\w+)\s*", re.IGNORECASE
)

ALLOWED_HINT = "Only read queries (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) are allowed."


@dataclass(frozen=True)
class PreparedQuery:
    sql: str  # what will be sent to the database
    streamable: bool  # Postgres: can run in a server-side cursor (SELECT-like)
    # The user's SQL (trailing ';' removed). Differs from `sql` when MySQL's LIMIT was capped.
    original_sql: str = ""

    @property
    def user_sql(self) -> str:
        return self.original_sql or self.sql


def prepare_sql(sql: str, db_type: str, fetch_limit: int) -> PreparedQuery:
    try:
        dialect = DIALECTS[db_type]
    except KeyError:
        raise QueryError("invalid", f"Unsupported database type: {db_type}") from None
    if not sql.strip():
        raise QueryError("invalid", "The query is empty.")

    statements = _parse(sql, dialect)
    if not statements:
        raise QueryError("invalid", "The query is empty.")
    if len(statements) > 1:
        raise QueryError(
            "multiple_statements",
            f"Only one statement per run is allowed (found {len(statements)}). "
            "Run them one at a time.",
        )

    statement = statements[0]
    check_read_only(statement, dialect)

    user_sql = _strip_trailing_semicolons(sql, dialect)
    sql_to_run = user_sql
    if db_type == "mysql" and isinstance(statement, exp.Query):
        sql_to_run = _cap_limit(statement, fetch_limit, dialect) or user_sql

    is_select_like = isinstance(statement, (exp.Query, exp.Values))
    return PreparedQuery(
        sql=sql_to_run,
        streamable=db_type == "postgresql" and is_select_like,
        original_sql=user_sql,
    )


_MISSING_PART = re.compile(r"Required keyword: '\w+' missing for <class '[\w.]+\.(\w+)'>")


def _readable(description: str) -> str:
    """Turn sqlglot's internal wording into something a SQL user understands."""
    description = _ANSI.sub("", description).split("\n")[0]
    if match := _MISSING_PART.search(description):
        return f"incomplete {match.group(1).upper()} clause"
    if description.startswith("Invalid expression / Unexpected token"):
        return "unexpected token"
    if description.startswith("Expecting "):
        return "expected " + description.removeprefix("Expecting ")
    return description


def _parse(sql: str, dialect: str) -> list[exp.Expr]:
    try:
        # None = empty statement (";;"); Semicolon = only a comment after the last ";".
        return [
            s
            for s in sqlglot.parse(sql, dialect=dialect)
            if s is not None and not isinstance(s, exp.Semicolon)
        ]
    except ParseError as e:
        first = e.errors[0] if e.errors else {}
        line, col = first.get("line"), first.get("col")
        description = _readable(str(first.get("description") or e))
        if line and col:
            near = _ANSI.sub("", str(first.get("highlight") or "")).strip()
            near_text = f" near '{near}'" if near else ""
            return _raise_syntax(
                f"Syntax error at line {line}, column {col}{near_text}: {description}", line, col
            )
        return _raise_syntax(f"Syntax error: {description}", None, None)
    except TokenError as e:
        return _raise_syntax(f"Syntax error: {_ANSI.sub('', str(e))}", None, None)


def _raise_syntax(message: str, line: int | None, col: int | None) -> list[exp.Expr]:
    raise QueryError("syntax", message, line, col)


def _keyword(node: exp.Expr) -> str:
    names = {
        "truncatetable": "TRUNCATE",
        "loaddata": "LOAD DATA",
        "lock": "SELECT ... FOR UPDATE / FOR SHARE (row locking)",
    }
    return names.get(node.key, node.key.upper())


def check_read_only(statement: exp.Expr, dialect: str) -> None:
    """Raise QueryError unless the statement only reads data."""
    if isinstance(statement, exp.Command):
        name = str(statement.this).upper()
        if name == "EXPLAIN":
            _check_explain(statement, dialect)
            return
        if name in _ALLOWED_COMMANDS:
            return
        first_word = name.split()[0] if name else "This"
        if first_word in _WRITE_WORDS:
            raise read_only_error(first_word)
        raise QueryError(
            "not_allowed", f"{first_word} statements are not supported. {ALLOWED_HINT}"
        )

    if not isinstance(statement, (exp.Query, exp.Values, exp.Show, exp.Describe)):
        if isinstance(statement, WRITE_NODES) and not isinstance(statement, (exp.Set, exp.Use)):
            raise read_only_error(_keyword(statement))
        raise QueryError(
            "not_allowed", f"{_keyword(statement)} statements are not supported. {ALLOWED_HINT}"
        )

    # Writes hidden inside a read, e.g. WITH d AS (DELETE ... RETURNING *) SELECT * FROM d
    for node in statement.walk():
        if isinstance(node, WRITE_NODES):
            raise read_only_error(_keyword(node))
        if isinstance(node, exp.Select) and node.args.get("into"):
            raise read_only_error("SELECT ... INTO")


def _check_explain(statement: exp.Command, dialect: str) -> None:
    """EXPLAIN [ANALYZE] <query>: the inner statement must be a read query too,
    because EXPLAIN ANALYZE really runs it."""
    rest = str(statement.expression.name if statement.expression else "")
    while (match := _EXPLAIN_OPTIONS.match(rest)) and match.group(0):
        rest = rest[match.end() :]
    try:
        inner = [s for s in sqlglot.parse(rest, dialect=dialect) if s is not None]
    except (ParseError, TokenError):
        raise QueryError(
            "not_allowed", f"Vita couldn't check this EXPLAIN statement. {ALLOWED_HINT}"
        ) from None
    if len(inner) != 1:
        raise QueryError(
            "not_allowed", f"Vita couldn't check this EXPLAIN statement. {ALLOWED_HINT}"
        )
    check_read_only(inner[0], dialect)


def _strip_trailing_semicolons(sql: str, dialect: str) -> str:
    """Cut the SQL right after its last real token, dropping trailing ';' and comments.
    Everything before stays byte-for-byte the same, so error positions still match."""
    tokens = list(sqlglot.Dialect.get_or_raise(dialect).tokenize(sql))
    while tokens and tokens[-1].token_type == TokenType.SEMICOLON:
        tokens.pop()
    if not tokens:
        return sql.strip()
    return sql[: tokens[-1].end + 1]


def _cap_limit(statement: exp.Query, fetch_limit: int, dialect: str) -> str | None:
    """Lower the outermost LIMIT to fetch_limit. Returns new SQL, or None to keep the original.
    Never raises a LIMIT the user wrote: LIMIT 10 stays LIMIT 10."""
    limit = statement.args.get("limit")
    if limit is not None:
        value = limit.expression
        if not (isinstance(value, exp.Literal) and value.is_int):
            return None  # e.g. LIMIT ? or an expression; leave it alone
        if int(value.this) <= fetch_limit:
            return None
    return statement.limit(fetch_limit, copy=True).sql(dialect=dialect)
