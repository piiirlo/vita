/** Dimensions that are a date bucket or a time part: "order_date@month", "created_at@hour_of_day".
 * The backend groups by the bucket (a DATE, like the time grain) or the integer part
 * (day_of_week 1 = Monday ... 7 = Sunday, hour_of_day 0-23, month_of_year 1-12). Pure. */
import type { Dataset, DatasetColumn, Grain } from "../api.ts";
import { formatBucket } from "./format.ts";

export type TimePart = "day_of_week" | "hour_of_day" | "month_of_year";
export type DimPart = Grain | TimePart;

const GRAIN_PARTS: Grain[] = ["day", "week", "month", "quarter", "year"];
export const SEPARATOR = "@";

export const PART_LABELS: Record<DimPart, string> = {
  day: "by day",
  week: "by week",
  month: "by month",
  quarter: "by quarter",
  year: "by year",
  day_of_week: "day of week",
  hour_of_day: "hour of day",
  month_of_year: "month of year",
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Every value a time part can have, in order (Monday first): heatmap axes show them all. */
export const PART_DOMAIN: Record<TimePart, number[]> = {
  day_of_week: [1, 2, 3, 4, 5, 6, 7],
  hour_of_day: Array.from({ length: 24 }, (_, h) => h),
  month_of_year: Array.from({ length: 12 }, (_, m) => m + 1),
};

export const isGrain = (part: DimPart | null): part is Grain => part !== null && (GRAIN_PARTS as string[]).includes(part);
export const isTimePart = (part: DimPart | null): part is TimePart => part !== null && part in PART_DOMAIN;

/** "order_date@month" -> { column: "order_date", part: "month" }; a plain (or unknown) name has
 * no part. A real column whose name contains "@" stays a column. */
export function splitDim(ref: string, dataset: Dataset | null): { column: string; part: DimPart | null } {
  const at = ref.lastIndexOf(SEPARATOR);
  if (at < 0 || dataset?.columns.some((c) => c.name === ref)) return { column: ref, part: null };
  const part = ref.slice(at + 1) as DimPart;
  return part in PART_LABELS ? { column: ref.slice(0, at), part } : { column: ref, part: null };
}

/** A value of a part as shown: "Mon", "08:00", "Mar", or the bucket label ("Mar 2026"). */
export function partValueLabel(value: unknown, part: DimPart): string | null {
  if (value === null || value === undefined) return null;
  if (isGrain(part)) return formatBucket(value, part);
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (part === "day_of_week") return DAYS[n - 1] ?? String(value);
  if (part === "month_of_year") return MONTHS[n - 1] ?? String(value);
  return `${String(n).padStart(2, "0")}:00`;
}

export type DimOption = { value: string; label: string };

/** Dimension choices: category columns, plus date buckets and / or time parts of time columns
 * (no hour for plain dates). Labels like "Order date · by month". */
export function dimensionOptions(
  columns: DatasetColumn[],
  { buckets = [], parts = [], raw = true }: { buckets?: Grain[]; parts?: TimePart[]; raw?: boolean } = {},
): DimOption[] {
  const out: DimOption[] = [];
  const name = (c: DatasetColumn) => c.label || c.name;
  for (const c of columns) {
    if (!c.is_temporal) {
      out.push({ value: c.name, label: name(c) });
      continue;
    }
    if (raw) out.push({ value: c.name, label: name(c) });
    // A year number (2006) only has years; text dates have no time of day.
    const years = c.time_kind === "year_number";
    for (const g of buckets) {
      if (years && g !== "year") continue;
      out.push({ value: `${c.name}${SEPARATOR}${g}`, label: `${name(c)} · ${PART_LABELS[g]}` });
    }
    for (const p of parts) {
      if (years) continue;
      if (p === "hour_of_day" && (c.effective_type === "date" || c.time_kind)) continue;
      out.push({ value: `${c.name}${SEPARATOR}${p}`, label: `${name(c)} · ${PART_LABELS[p]}` });
    }
  }
  return out;
}
