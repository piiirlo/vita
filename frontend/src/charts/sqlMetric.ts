/** Custom SQL metrics in the chart editor: column autocomplete and the saved-metric name. Pure. */
import type { DatasetColumn } from "../api.ts";

export const SQL_FUNCTIONS = ["SUM", "AVG", "COUNT", "MIN", "MAX", "NULLIF", "COALESCE", "ROUND", "ABS", "CASE WHEN"];

export type Completion = { label: string; insert: string; kind: "column" | "function"; detail?: string };
export type Completions = { from: number; to: number; items: Completion[] };

/** A column name as typed in SQL: plain lower-case names as they are, anything else quoted
 * ("Order Date" on Postgres, `Order Date` on MySQL). */
export function sqlIdentifier(name: string, dbType: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return dbType === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** Suggestions for the word being typed at `cursor`: the dataset's columns (by name or
 * label) and common functions. Nothing inside a string literal or right after a digit. */
export function sqlCompletions(text: string, cursor: number, columns: DatasetColumn[], dbType: string, max = 8): Completions | null {
  const before = text.slice(0, cursor);
  // Inside an unfinished 'string': no suggestions.
  if ((before.match(/'/g) ?? []).length % 2 === 1) return null;
  // A quoted name being typed ("Order Da) or a plain word (amou).
  const quoteChar = dbType === "mysql" ? "`" : '"';
  const quoted = before.split(quoteChar).length % 2 === 0 ? new RegExp(`\\${quoteChar}([^${quoteChar}]*)$`).exec(before) : null;
  const plain = quoted ? null : /(?:^|[^\w.])([A-Za-z_]\w*)$/.exec(before);
  const quote = quoted ? quoteChar : "";
  const word = quoted ? quoted[1]! : (plain?.[1] ?? "");
  if (!quoted && !word) return null;
  const from = cursor - word.length - quote.length;
  const q = word.toLowerCase();
  const items: Completion[] = [];
  for (const c of columns) {
    if (c.is_missing || c.is_hidden) continue;
    if (c.name.toLowerCase().startsWith(q) || (c.label ?? "").toLowerCase().startsWith(q)) {
      items.push({ label: c.name, insert: sqlIdentifier(c.name, dbType), kind: "column", detail: c.label && c.label !== c.name ? c.label : c.effective_type });
    }
  }
  if (!quote && q) {
    for (const f of SQL_FUNCTIONS) if (f.toLowerCase().startsWith(q)) items.push({ label: f, insert: f === "CASE WHEN" ? "CASE WHEN " : `${f}(`, kind: "function" });
  }
  const exact = items.length === 1 && items[0]!.insert === text.slice(from, cursor);
  return items.length && !exact ? { from, to: cursor, items: items.slice(0, max) } : null;
}

/** Apply a completion: the new text and cursor. */
export function applyCompletion(text: string, done: Completions, item: Completion): { text: string; cursor: number } {
  const next = text.slice(0, done.from) + item.insert + text.slice(done.to);
  return { text: next, cursor: done.from + item.insert.length };
}

/** A saved metric's name from a label: "Price per unit" -> "price_per_unit" (made unique). */
export function metricNameFor(label: string, taken: string[]): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "metric";
  const used = new Set(taken.map((t) => t.toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  return name;
}
