/** Conditional colors (every chart type that draws single values: bars, points, slices, boxes,
 * steps, table cells, the big number) and per-series colors. Pure.
 *
 * A rule colors a value above or below a threshold with a tone (success / danger / warning).
 * Color is never the only signal: a colored value always shows its label with a marker
 * (▲ above, ▼ below), and table cells get the marker too. */
import type { VizType } from "../api.ts";
import type { ChartState, DisplayOptions } from "./model.ts";

export type RuleTone = "success" | "danger" | "warning";
export type ColorRule = {
  /** "above": value > threshold; "below": value < threshold. */
  when: "above" | "below";
  value: number;
  tone: RuleTone;
  /** Only this metric (by name); none = every metric. */
  metric?: string | null;
};

/** One click: positive values in the success color, negative ones in the danger color. */
export const POSITIVE_NEGATIVE: ColorRule[] = [
  { when: "above", value: 0, tone: "success" },
  { when: "below", value: 0, tone: "danger" },
];

export const TONE_LABELS: Record<RuleTone, string> = { success: "Green", danger: "Red", warning: "Amber" };

/** Chart types with their own color scales or bands: rules don't apply. */
const NO_RULES = new Set<VizType>(["heatmap", "world_map", "gauge"]);
export function rulesApply(viz: VizType): boolean {
  return !NO_RULES.has(viz);
}
export const NO_RULES_HINT: Partial<Record<VizType, string>> = {
  heatmap: "A heatmap colors every cell by its value already",
  world_map: "A world map colors every country by its value already",
  gauge: "Use the gauge's color bands",
};

/** The chart's rules: `color_rules`, else the big number's older below / above thresholds. */
export function colorRules(display: DisplayOptions): ColorRule[] {
  if (display.color_rules) return display.color_rules;
  const rules: ColorRule[] = [];
  if (display.color_below !== null && display.color_below !== undefined) rules.push({ when: "below", value: display.color_below, tone: "danger" });
  if (display.color_above !== null && display.color_above !== undefined) rules.push({ when: "above", value: display.color_above, tone: "success" });
  return rules;
}

export function isPositiveNegative(rules: ColorRule[]): boolean {
  return (
    rules.length === 2 &&
    rules.every((r, i) => {
      const p = POSITIVE_NEGATIVE[i]!;
      return r.when === p.when && r.value === p.value && r.tone === p.tone && !r.metric;
    })
  );
}

/** The first rule that matches a value of a metric (null: none, or not a number). */
export function ruleFor(value: unknown, metric: string, rules: ColorRule[]): ColorRule | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  for (const rule of rules) {
    if (rule.metric && rule.metric !== metric) continue;
    if (!Number.isFinite(rule.value)) continue;
    if (rule.when === "above" ? n > rule.value : n < rule.value) return rule;
  }
  return null;
}

export const ruleMarker = (rule: ColorRule): string => (rule.when === "above" ? "▲" : "▼");

/** A rule's description for screen readers / tooltips: "above 0". */
export function ruleText(rule: ColorRule, format: (v: unknown) => string): string {
  return `${rule.when === "above" ? "Above" : "Below"} ${format(rule.value)}`;
}

/** Colors resolved from the theme (canvas can't read CSS variables). */
export type ToneColors = Partial<Record<RuleTone, string>>;

/** An ECharts data item for a value: unchanged when no rule matches; else colored, with its
 * label shown and marked (▲ / ▼) so color isn't the only signal. `extra` is merged in (e.g.
 * the dashed style of an incomplete period). */
export function ruledItem(
  value: unknown,
  metric: string,
  rules: ColorRule[],
  tones: ToneColors,
  format: (v: unknown) => string,
  extra: Record<string, unknown> | null = null,
  labelColor?: string,
): unknown {
  const rule = rules.length ? ruleFor(value, metric, rules) : null;
  if (!rule) return extra ? { value, ...extra } : value;
  const color = tones[rule.tone];
  const extraStyle = (extra?.itemStyle as Record<string, unknown> | undefined) ?? {};
  return {
    ...(extra ?? {}),
    value,
    itemStyle: { ...extraStyle, ...(color ? { color } : {}) },
    label: {
      show: true,
      formatter: () => `${ruleMarker(rule)} ${format(value)}`,
      fontSize: 11,
      ...(labelColor ? { color: labelColor } : {}),
    },
    // Line / area points: shown even when the series hides its points.
    symbol: "circle",
    symbolSize: 8,
  };
}

/** The palette index (1-10) the user picked for a series, by its original name. */
export function seriesColorIndex(display: DisplayOptions, name: string): number | null {
  return display.series_colors?.[name] ?? null;
}

/** The color of a series / slice: the user's pick, else the palette in order. */
export function pickSeriesColor(display: DisplayOptions, name: string, index: number, palette: string[]): string | undefined {
  const picked = seriesColorIndex(display, name);
  if (picked && palette[picked - 1]) return palette[picked - 1];
  return palette.length ? palette[index % palette.length] : undefined;
}

/** Table / pivot cells: the rule's tone as a class and its marker. */
export function cellRule(state: ChartState, metric: string, value: unknown): ColorRule | null {
  if (!rulesApply(state.vizType)) return null;
  return ruleFor(value, metric, colorRules(state.display));
}
