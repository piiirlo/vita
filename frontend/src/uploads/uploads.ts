/** Upload helpers (pure, unit-tested): labels, sizes, which options re-guess the columns. */
import type { DateOrder, UploadColumnType, UploadProblem, UploadReadOptions } from "../api.ts";

export const ENCODINGS: { value: UploadReadOptions["encoding"]; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-8-sig", label: "UTF-8 with BOM" },
  { value: "windows-1252", label: "Windows-1252" },
  { value: "iso-8859-1", label: "ISO-8859-1 (Latin-1)" },
];

export const DELIMITERS: { value: UploadReadOptions["delimiter"]; label: string }[] = [
  { value: ",", label: "Comma ," },
  { value: ";", label: "Semicolon ;" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe |" },
];

export const DECIMALS: { value: UploadReadOptions["decimal"]; label: string }[] = [
  { value: ".", label: "Dot (4.20)" },
  { value: ",", label: "Comma (4,20)" },
];

export const THOUSANDS: { value: UploadReadOptions["thousands"]; label: string }[] = [
  { value: "", label: "None" },
  { value: ",", label: "Comma (1,234)" },
  { value: ".", label: "Dot (1.234)" },
  { value: " ", label: "Space (1 234)" },
  { value: "'", label: "Apostrophe (1'234)" },
];

export const COLUMN_TYPES: { value: UploadColumnType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "integer", label: "Integer" },
  { value: "decimal", label: "Decimal" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date and time" },
  { value: "boolean", label: "Yes / no" },
];

export const DATE_ORDERS: { value: DateOrder; label: string }[] = [
  { value: "dmy", label: "Day / month / year (15/03/2024)" },
  { value: "mdy", label: "Month / day / year (03/15/2024)" },
  { value: "ymd", label: "Year-month-day (2024-03-15)" },
];

export const typeLabel = (type: UploadColumnType) => COLUMN_TYPES.find((t) => t.value === type)?.label ?? type;

/** "4.2 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What identifies a set of problems (a new set opens the adjust panel again). */
export const problemsKey = (problems: UploadProblem[]) => problems.map((p) => `${p.kind}:${p.column ?? ""}`).join("|");

/** Changing how the file is split means the columns must be guessed again. */
export function withReadOption<K extends keyof UploadReadOptions>(options: UploadReadOptions, key: K, value: UploadReadOptions[K]): UploadReadOptions {
  const regroup =
    key === "delimiter" || key === "header" || key === "skip_rows" || key === "encoding" || key === "decimal" || key === "thousands" || key === "sheet";
  return { ...options, [key]: value, ...(regroup ? { columns: null } : {}) };
}


/** The options are what was detected (so "Reset to detected" has nothing to do). */
export function sameReadOptions(a: UploadReadOptions, b: UploadReadOptions): boolean {
  const plain = (o: UploadReadOptions) => [o.encoding, o.delimiter, o.header, o.skip_rows, o.decimal, o.thousands, o.sheet ?? null];
  if (JSON.stringify(plain(a)) !== JSON.stringify(plain(b))) return false;
  const cols = (o: UploadReadOptions) => (o.columns ?? []).map((c) => [c.index, c.name, c.type, c.ignore, c.date_order]);
  return a.columns === null || b.columns === null || JSON.stringify(cols(a)) === JSON.stringify(cols(b));
}
