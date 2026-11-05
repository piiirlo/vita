/** Pure helpers for query results: sorting, CSV, cell text, error positions. */
import type { GenericType } from "../api.ts";

export type SortState = { column: number; desc: boolean } | null;

function compareNonNull(a: unknown, b: unknown, type: GenericType): number {
  if (type === "number" && typeof a === "number" && typeof b === "number") return a - b;
  if (type === "boolean") return Number(a) - Number(b);
  // ISO dates/datetimes sort correctly as strings; numbers sent as strings (huge decimals) too-ish.
  if (type === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  }
  const sa = typeof a === "object" ? JSON.stringify(a) : String(a);
  const sb = typeof b === "object" ? JSON.stringify(b) : String(b);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
}

/** Sort rows by one column. NULLs always go last, in both directions. Stable. */
export function sortRows(rows: unknown[][], sort: SortState, types: GenericType[]): unknown[][] {
  if (!sort) return rows;
  const type = types[sort.column] ?? "other";
  const direction = sort.desc ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const a = x.row[sort.column];
      const b = y.row[sort.column];
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull || bNull) return aNull === bNull ? x.index - y.index : aNull ? 1 : -1;
      return compareNonNull(a, b, type) * direction || x.index - y.index;
    })
    .map((item) => item.row);
}

/** Clicking a header cycles: ascending -> descending -> unsorted. */
export function nextSort(current: SortState, column: number): SortState {
  if (!current || current.column !== column) return { column, desc: false };
  if (!current.desc) return { column, desc: true };
  return null;
}

/** Text for a cell (also what "copy" puts on the clipboard). NULL -> "NULL". */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------- CSV ----------

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV with a header row. NULL becomes an empty field. */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function downloadCsv(filename: string, csv: string): void {
  // The BOM makes Excel open UTF-8 correctly.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvFilename(title: string, now: Date = new Date()): string {
  const safe = title.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "query";
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${safe}_${stamp}.csv`;
}

// ---------- error position ----------

export type RunOffset = { startLine: number; startColumn: number };

/**
 * Map an error position in the SQL that was run back to the editor. When only a
 * selection was run, its first line starts at `startColumn`, later lines at column 1.
 * column null = unknown column (MySQL gives only a line): underline the whole line.
 */
export function editorErrorPosition(
  error: { line: number | null; column: number | null },
  offset: RunOffset,
): { line: number; column: number | null } | null {
  if (error.line === null || error.line < 1) return null;
  const line = offset.startLine + error.line - 1;
  if (error.column === null) return { line, column: null };
  const column = error.line === 1 ? offset.startColumn + error.column - 1 : error.column;
  return { line, column };
}

// ---------- formatting ----------

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
