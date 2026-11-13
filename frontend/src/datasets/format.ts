import type { DateOrder, GenericType } from "../api.ts";

export const GENERIC_TYPES: GenericType[] = ["number", "string", "date", "datetime", "boolean", "other"];

/** Suggestions for a metric's number format (numeral.js-style; used by charts in Part 6). */
export const NUMBER_FORMATS = [
  { value: "0,0", hint: "1,234" },
  { value: "0,0.00", hint: "1,234.57" },
  { value: "0.0%", hint: "12.3%" },
  { value: "0.0a", hint: "1.2k" },
  { value: "$0,0.00", hint: "$1,234.57" },
];

/** "3 minutes ago", "yesterday", or a date for older times. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How dates are written, for text dates and uploaded files: "Day first: DD-MM-YYYY". */
export const DATE_FORMAT_LABELS: Record<DateOrder, string> = {
  ymd: "Year first: YYYY-MM-DD",
  dmy: "Day first: DD-MM-YYYY",
  mdy: "Month first: MM-DD-YYYY",
};
