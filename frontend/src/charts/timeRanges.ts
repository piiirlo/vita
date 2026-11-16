import type { RangeKind } from "../api.ts";

/** Time range choices: the chart editor and dashboard time filters offer the same ones. */
export const TIME_RANGES: { value: RangeKind; label: string }[] = [
  { value: "none", label: "No filter" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom…" },
];
