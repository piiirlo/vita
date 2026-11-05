/** Pure helpers for SQL autocomplete (no Monaco imports, so they're easy to test). */
import type { DbType } from "../api.ts";

export type TableRef = { schema: string | null; table: string; alias: string | null };

export type CompletionTarget =
  | { kind: "columns"; schema: string | null; table: string }
  | { kind: "tables"; schema: string }
  | null;

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*)`;

// FROM / JOIN <schema.table | table> [AS] [alias]
const TABLE_REF = new RegExp(
  String.raw`\b(?:from|join)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:as\s+)?(${IDENT}))?`,
  "gi",
);

// Words that can follow a table name but are not an alias.
const NOT_ALIAS = new Set([
  "on", "where", "join", "left", "right", "inner", "outer", "full", "cross", "natural",
  "group", "order", "limit", "offset", "using", "union", "intersect", "except", "having",
  "window", "lateral", "as", "fetch", "for", "into", "set", "values", "select", "from",
  "and", "or", "straight_join",
]); // prettier-ignore

export function unquote(identifier: string): string {
  const id = identifier.trim();
  if ((id.startsWith('"') && id.endsWith('"')) || (id.startsWith("`") && id.endsWith("`"))) {
    return id.slice(1, -1);
  }
  return id;
}

function splitQualified(name: string): string[] {
  const parts: string[] = [];
  const re = new RegExp(IDENT, "g");
  for (const match of name.matchAll(re)) parts.push(unquote(match[0]));
  return parts;
}

/** Tables referenced in FROM / JOIN clauses, with their aliases. */
export function extractTableRefs(sql: string): TableRef[] {
  const refs: TableRef[] = [];
  for (const match of sql.matchAll(TABLE_REF)) {
    const parts = splitQualified(match[1] ?? "");
    const table = parts[parts.length - 1];
    if (!table) continue;
    const schema = parts.length > 1 ? (parts[0] ?? null) : null;
    const aliasRaw = match[2];
    const alias = aliasRaw && !NOT_ALIAS.has(aliasRaw.toLowerCase()) ? unquote(aliasRaw) : null;
    refs.push({ schema, table, alias });
  }
  return refs;
}

/** "SELECT o." -> "o"; the identifier right before a trailing dot, if any. */
export function qualifierBeforeCursor(textBeforeWord: string): string | null {
  const match = new RegExp(String.raw`(${IDENT})\s*\.\s*$`).exec(textBeforeWord);
  return match?.[1] ? unquote(match[1]) : null;
}

/** What to suggest after "<qualifier>.": columns of a table/alias, or tables of a schema. */
export function resolveQualifier(
  qualifier: string,
  refs: TableRef[],
  schemas: string[],
): CompletionTarget {
  const q = qualifier.toLowerCase();
  const ref =
    refs.find((r) => r.alias?.toLowerCase() === q) ?? refs.find((r) => r.table.toLowerCase() === q);
  if (ref) return { kind: "columns", schema: ref.schema, table: ref.table };
  const schema = schemas.find((s) => s.toLowerCase() === q);
  if (schema) return { kind: "tables", schema };
  return null;
}

/** Quote an identifier only when needed. */
export function quoteIdent(name: string, dbType: DbType): string {
  if (dbType === "mysql") {
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;
  }
  // Postgres folds unquoted names to lower case, so mixed case needs quotes.
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

export function qualifiedName(schema: string | null, table: string, dbType: DbType): string {
  const t = quoteIdent(table, dbType);
  return schema ? `${quoteIdent(schema, dbType)}.${t}` : t;
}

export const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "JOIN",
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL OUTER JOIN", "CROSS JOIN", "ON", "USING",
  "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "IS NOT NULL", "LIKE", "ILIKE", "BETWEEN",
  "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "UNION", "UNION ALL", "INTERSECT",
  "EXCEPT", "WITH", "EXISTS", "ASC", "DESC", "NULLS FIRST", "NULLS LAST", "TRUE", "FALSE",
  "OVER", "PARTITION BY", "ROWS BETWEEN", "INTERVAL", "SHOW", "DESCRIBE", "EXPLAIN",
]; // prettier-ignore

export const SQL_FUNCTIONS = [
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "CAST", "ROUND", "ABS",
  "LOWER", "UPPER", "TRIM", "LENGTH", "SUBSTRING", "CONCAT", "REPLACE", "NOW",
  "CURRENT_DATE", "CURRENT_TIMESTAMP", "DATE_TRUNC", "EXTRACT", "DATE", "YEAR", "MONTH",
  "ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "STRING_AGG", "GROUP_CONCAT",
  "PERCENTILE_CONT", "TO_CHAR", "DATE_FORMAT",
]; // prettier-ignore
