/** The "Customize" side of a chart: number formats, which options apply, comparison periods,
 * incomplete periods and axis-label layout. Pure functions (unit-tested in display.test.ts). */
import type { Dataset, Grain, MetricRef, RangeKind } from "../api.ts";
import { DEFAULT_NUMBER_FORMAT, formatNumber, toNumber } from "./format.ts";
import { metricFormat, metricName, type ChartState, type DisplayOptions } from "./model.ts";

// ---------- number formats ----------

export type FormatPreset = "number" | "currency" | "percent" | "compact" | "custom";

/** A chart's own format for one metric. It wins over the metric's saved format, and works for
 * ad-hoc metrics too. */
export type FormatSpec = {
  preset: FormatPreset;
  /** null / undefined: the preset's default. */
  decimals?: number | null;
  /** Currency symbol, e.g. "$" or "€". */
  symbol?: string;
  /** numeral.js format for preset "custom", e.g. "0,0.000". */
  custom?: string;
  prefix?: string;
  suffix?: string;
};

export const FORMAT_PRESETS: { value: FormatPreset; label: string; example: string }[] = [
  { value: "number", label: "Number", example: "67,416.51" },
  { value: "currency", label: "Currency", example: "$67,416.51" },
  { value: "percent", label: "Percent", example: "12.5%" },
  { value: "compact", label: "Compact", example: "67.4k" },
  { value: "custom", label: "Custom", example: "0,0.000" },
];

const decimalsPart = (d: number) => (d > 0 ? `.${"0".repeat(d)}` : "");

/** The numeral.js format string a spec stands for. */
export function numeralFormat(spec: FormatSpec): string {
  const d = spec.decimals ?? null;
  switch (spec.preset) {
    case "number":
      return d === null ? DEFAULT_NUMBER_FORMAT : `0,0${decimalsPart(d)}`;
    case "currency":
      return `0,0${decimalsPart(d ?? 2)}`;
    case "percent":
      return `0${decimalsPart(d ?? 1)}%`;
    case "compact":
      return d === null ? "0.[0]a" : `0${decimalsPart(d)}a`;
    case "custom":
      return spec.custom?.trim() || DEFAULT_NUMBER_FORMAT;
  }
}

/** Format one value with a spec: "-$1,234.50", "67.4K", "12.5%", with prefix / suffix. */
export function formatWithSpec(value: unknown, spec: FormatSpec): string {
  const n = toNumber(value);
  if (n === null) return formatNumber(value);
  let text = formatNumber(n, numeralFormat(spec));
  if (spec.preset === "compact") text = text.replace(/[kmbt]$/, (unit) => unit.toUpperCase());
  if (spec.preset === "currency") {
    const symbol = spec.symbol ?? "$";
    text = text.startsWith("-") ? `-${symbol}${text.slice(1)}` : `${symbol}${text}`;
  }
  return `${spec.prefix ?? ""}${text}${spec.suffix ?? ""}`;
}

/** How a metric's values are shown: the chart's own format if set, else the metric's saved
 * number format, else the default. */
export function metricFormatter(display: DisplayOptions, metric: MetricRef, dataset: Dataset | null): (value: unknown) => string {
  const spec = display.formats?.[metricName(metric)];
  if (spec) return (value) => formatWithSpec(value, spec);
  const saved = metricFormat(metric, dataset);
  return (value) => formatNumber(value, saved);
}

// ---------- which options apply ----------

/** Several lines / bar groups: a series column or more than one metric. */
export const hasSeveralSeries = (state: ChartState) => Boolean(state.query.series) || state.query.metrics.length > 1;

/** The x axis is time buckets (not a dimension). */
export const hasTimeAxis = (state: ChartState) =>
  Boolean(state.query.time?.grain && state.query.time.column) && state.query.dimensions.length === 0;

export type CustomizeOption =
  | "stacked"
  | "sort"
  | "legend"
  | "single_color"
  | "axis_titles"
  | "value_labels"
  | "series_labels"
  | "show_trend"
  | "trend_dates"
  | "compare_previous";

/** Options that don't apply right now, each with a short hint saying why (or what to do). */
export function unavailableOptions(state: ChartState, dataset: Dataset | null): Partial<Record<CustomizeOption, string>> {
  const hints: Partial<Record<CustomizeOption, string>> = {};
  const { vizType, display, query } = state;
  const several = hasSeveralSeries(state);
  if (vizType === "table") {
    hints.legend = "Tables have no legend";
    hints.axis_titles = "Tables have no axes";
    hints.value_labels = "Tables already show every value";
  }
  if (vizType === "big_number") {
    hints.legend = "A big number has no legend";
    hints.axis_titles = "A big number has no axes";
    hints.value_labels = "The big number is the value";
    const hasTimeColumn = Boolean(dataset?.columns.some((c) => c.is_temporal && !c.is_hidden && !c.is_missing));
    if (!hasTimeColumn) hints.show_trend = "This dataset has no time column";
    if (!display.show_trend) hints.trend_dates = "Turn on the trend line first";
    if (!query.time?.column || (query.time.range.kind ?? "none") === "none")
      hints.compare_previous = "Set a time range to compare with the period before";
  }
  if (vizType === "pie") {
    hints.axis_titles = "A pie has no axes";
    hints.single_color = "Each slice needs its own color";
  }
  if (vizType === "bar" || vizType === "line") {
    if (!several) {
      hints.stacked = "Add a series to stack bars";
      hints.legend = "One series: nothing to tell apart";
    } else {
      hints.single_color = "One color only works with a single series";
    }
    if (vizType === "bar" && hasTimeAxis(state)) hints.sort = "Time bars are always in date order";
  }
  return hints;
}

/** Display options that change the query (everything else redraws the loaded data). */
const QUERY_DISPLAY_KEYS = ["mode", "show_trend", "compare_previous", "donut"] as const;

/** What to draw a loaded result with: the state it was made for, plus the current look
 * (formats, colors, stacking…), which never needs a new query. A result of another chart
 * type keeps its own state, so a stale result is never drawn as a different chart. */
export function drawState(shown: ChartState, current: ChartState): ChartState {
  if (shown.vizType !== current.vizType) return shown;
  const display: DisplayOptions = { ...current.display };
  for (const key of QUERY_DISPLAY_KEYS) {
    if (shown.display[key] === undefined) delete display[key];
    else (display as Record<string, unknown>)[key] = shown.display[key];
  }
  return { ...shown, display };
}

// ---------- dates ----------

const DAY_MS = 86_400_000;
const parseDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => isoDate(new Date(parseDate(iso).getTime() + days * DAY_MS));
const daysBetween = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);

function addMonths(iso: string, months: number): string {
  const d = parseDate(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return isoDate(target);
}

/** Today in the browser's time zone, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The period to compare a big number with: the same stretch just before. Calendar ranges
 * move back by their calendar unit ("this year so far" vs the same days last year); the rest
 * move back by their length. The end is clipped to today (a year isn't over yet). Both dates
 * inclusive. */
export function previousRange(
  kind: RangeKind,
  start: string | null | undefined,
  end: string | null | undefined,
  today: string,
): { start: string; end: string } | null {
  if (!start || !end) return null;
  const clippedEnd = end > today ? today : end;
  if (clippedEnd < start) return null;
  if (kind === "this_year" || kind === "last_year") return { start: addMonths(start, -12), end: addMonths(clippedEnd, -12) };
  if (kind === "last_12_months") return { start: addMonths(start, -12), end: addMonths(clippedEnd, -12) };
  // Whole months (e.g. Apr 1 - Jun 30) compare with the same number of whole months before.
  const after = addDays(clippedEnd, 1);
  if (start.endsWith("-01") && after.endsWith("-01")) {
    const months = (Number(after.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(after.slice(5, 7)) - Number(start.slice(5, 7));
    return { start: addMonths(start, -months), end: addDays(start, -1) };
  }
  const length = daysBetween(start, clippedEnd) + 1;
  return { start: addDays(start, -length), end: addDays(start, -1) };
}

/** Change from the previous period, e.g. 0.123 for +12.3%. null when it can't be computed. */
export function changeRatio(current: unknown, previous: unknown): number | null {
  const c = toNumber(current);
  const p = toNumber(previous);
  if (c === null || p === null || p === 0) return null;
  return (c - p) / Math.abs(p);
}

// ---------- incomplete periods ----------

/** The first day after the bucket that starts on `start`. */
export function bucketEnd(start: string, grain: Grain): string {
  switch (grain) {
    case "day":
      return addDays(start, 1);
    case "week":
      return addDays(start, 7);
    case "month":
      return addMonths(start, 1);
    case "quarter":
      return addMonths(start, 3);
    case "year":
      return addMonths(start, 12);
  }
}

export type Coverage = {
  /** The chart's time range, days inclusive (from the chart-data response). */
  rangeStart?: string | null;
  rangeEnd?: string | null;
  /** Where the dataset has data (MIN / MAX of the time column). */
  dataMin?: string | null;
  dataMax?: string | null;
};

/** Indexes of the first / last time buckets that are only partly covered by the time range
 * or by the data (e.g. the current month, or the last month of the dataset). */
export function incompleteBuckets(buckets: unknown[], grain: Grain | null, coverage: Coverage): Set<number> {
  const partial = new Set<number>();
  if (!grain || buckets.length === 0) return partial;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const from = [coverage.rangeStart, coverage.dataMin].map(day).filter((d): d is string => d !== null);
  const until = [coverage.rangeEnd, coverage.dataMax].map(day).filter((d): d is string => d !== null);
  const coveredFrom = from.length ? from.sort().at(-1)! : null; // the later start
  const coveredUntil = until.length ? addDays(until.sort()[0]!, 1) : null; // the earlier end, exclusive

  const first = day(buckets[0]);
  if (first && coveredFrom && coveredFrom > first && coveredFrom < bucketEnd(first, grain)) partial.add(0);
  const lastIndex = buckets.length - 1;
  const last = day(buckets[lastIndex]);
  if (last && coveredUntil && coveredUntil > last && coveredUntil < bucketEnd(last, grain)) partial.add(lastIndex);
  return partial;
}

// ---------- axis labels ----------

export type LabelPlan = {
  rotate: number;
  /** Labels longer than this (px) are cut with "…" (the full text is in the tooltip). */
  maxWidth: number;
  /** 0 = every label. "auto" only when they can't fit even rotated (then `crowded`). */
  interval: 0 | "auto";
  crowded: boolean;
  truncated: boolean;
  /** Many long labels: horizontal bars would read better. */
  suggestHorizontal: boolean;
};

const CHAR_WIDTH = 6.8; // 11px JetBrains Mono
const LABEL_HEIGHT = 14;
const MAX_LABEL_WIDTH = 140;
const AXIS_SPACE = 60; // value-axis labels and padding

/** Never hide category labels silently: keep them all and rotate (up to 45°) or cut long ones;
 * only when even that can't fit say so (`crowded`) and suggest horizontal bars. */
export function planLabels(labels: string[], width: number | undefined, horizontal: boolean): LabelPlan {
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  const textWidth = longest * CHAR_WIDTH;
  const none = { crowded: false, truncated: false, suggestHorizontal: false };
  if (horizontal) {
    const maxWidth = Math.round(Math.min(220, Math.max(80, (width || 600) * 0.3)));
    return { ...none, rotate: 0, maxWidth, interval: 0, truncated: textWidth > maxWidth };
  }
  if (!width || labels.length === 0) return { ...none, rotate: 0, maxWidth: MAX_LABEL_WIDTH, interval: 0 };
  const perLabel = Math.max(0, width - AXIS_SPACE) / labels.length;
  if (textWidth + 8 <= perLabel) return { ...none, rotate: 0, maxWidth: Math.floor(perLabel - 4), interval: 0 };
  const truncated = textWidth > MAX_LABEL_WIDTH;
  const maxWidth = Math.min(Math.ceil(textWidth), MAX_LABEL_WIDTH);
  if (perLabel >= LABEL_HEIGHT) {
    return { rotate: 45, maxWidth, interval: 0, crowded: false, truncated, suggestHorizontal: longest > 14 && labels.length > 6 };
  }
  return { rotate: 45, maxWidth, interval: "auto", crowded: true, truncated, suggestHorizontal: true };
}
