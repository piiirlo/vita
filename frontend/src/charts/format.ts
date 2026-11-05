import numeral from "numeral";
import type { Grain } from "../api.ts";

/** Shown for NULL dimension values. */
export const EMPTY_LABEL = "(empty)";
/** Used when a metric has no number format: thousands separators, up to 2 decimals. */
export const DEFAULT_NUMBER_FORMAT = "0,0.[00]";

/** Numbers can arrive as strings (high-precision numerics keep every digit). */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Format with a numeral.js format like "0,0.00", "0.0%", "0.0a" or "$0,0". */
export function formatNumber(value: unknown, format?: string | null): string {
  const n = toNumber(value);
  if (n === null) return value === null || value === undefined ? "–" : String(value);
  const text = numeral(n).format(format || DEFAULT_NUMBER_FORMAT);
  // numeral returns "NaN" for formats it doesn't understand; fall back to the default.
  return text === "NaN" ? numeral(n).format(DEFAULT_NUMBER_FORMAT) : text;
}

function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A time bucket ("2025-03-01") as a label that fits the grain: "Mar 2025", "Q1 2025", ... */
export function formatBucket(value: unknown, grain: Grain | null): string {
  if (value === null || value === undefined) return EMPTY_LABEL;
  const day = typeof value === "string" ? parseDay(value) : null;
  if (!day) return String(value);
  switch (grain) {
    case "year":
      return String(day.getUTCFullYear());
    case "quarter":
      return `Q${Math.floor(day.getUTCMonth() / 3) + 1} ${day.getUTCFullYear()}`;
    case "month":
      return MONTH_YEAR.format(day);
    default: // day, week (the Monday it starts on), or a plain date
      return DAY.format(day);
  }
}

/** Label for an x-axis / series value. */
export function categoryLabel(value: unknown, grain: Grain | null = null): string {
  if (value === null || value === undefined) return EMPTY_LABEL;
  if (grain) return formatBucket(value, grain);
  return String(value);
}
