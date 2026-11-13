/** Treemap, funnel and gauge: result rows -> ECharts options. Pure functions. */
import type { EChartsOption } from "echarts";
import { isSqlMetric, type ChartDataResult, type Dataset } from "../api.ts";
import { metricFormatter } from "./display.ts";
import { toNumber } from "./format.ts";
import { dimensionLabel, metricLabel, metricName, type ChartState, type GaugeBand, type GaugeTone } from "./model.ts";
import { OTHER_COLUMN, OTHER_LABEL, seriesLabel, toneColors, type DrawContext } from "./options.ts";
import { colorRules, pickSeriesColor, ruleFor, ruleMarker } from "./colorRules.ts";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const columnIndex = (result: ChartDataResult, name: string) => result.columns.findIndex((c) => c.name === name);

/** Relative luminance of "#rrggbb" (null if it isn't one). */
function luminance(color: string | undefined): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color?.trim() ?? "");
  if (!m) return null;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Of the text candidates (token colors), the one with the most contrast on `fill`. */
export function readableOn(fill: string | undefined, candidates: (string | undefined)[]): string | undefined {
  const options = candidates.filter((c): c is string => Boolean(c));
  const lf = luminance(fill);
  if (lf === null) return options[0];
  const ratio = (c: string) => {
    const lc = luminance(c);
    return lc === null ? 0 : (Math.max(lf, lc) + 0.05) / (Math.min(lf, lc) + 0.05);
  };
  return options.reduce<string | undefined>((best, c) => (best === undefined || ratio(c) > ratio(best) ? c : best), undefined);
}
const keyOf = (v: unknown) => (v === null || v === undefined ? "\u0000null" : String(v));

// ---------- treemap ----------

export type TreemapNode = {
  name: string;
  value: number | null;
  /** Outer boxes with children: their own value from the second query (an average is not
   * the sum of its parts). Undefined when unknown. */
  ownValue?: number | null;
  other: boolean;
  children?: TreemapNode[];
};

/** Rows [level1, level2?, __other, metric] -> boxes. `total`: rows [level1, __other, metric]
 * with each outer box's own value (two levels only). */
export function treemapTree(state: ChartState, result: ChartDataResult, dataset: Dataset | null, total?: ChartDataResult | null): TreemapNode[] {
  const [outerDim = "", innerDim] = state.query.dimensions;
  const metric = state.query.metrics[0];
  const mi = metric ? columnIndex(result, metricName(metric)) : -1;
  const oi = columnIndex(result, OTHER_COLUMN);
  const d0 = columnIndex(result, outerDim);
  const d1 = innerDim ? columnIndex(result, innerDim) : -1;
  const label = (value: unknown, dim: string) => seriesLabel(dimensionLabel(value, dim, dataset), state.display);

  const own = new Map<string, number | null>();
  if (total && innerDim) {
    const t0 = columnIndex(total, outerDim);
    const to = columnIndex(total, OTHER_COLUMN);
    const tm = metric ? columnIndex(total, metricName(metric)) : -1;
    for (const row of total.rows) own.set(toNumber(row[to]) === 1 ? "\u0000other" : keyOf(row[t0]), toNumber(row[tm]));
  }

  const outer = new Map<string, TreemapNode>();
  for (const row of result.rows) {
    const other = oi >= 0 && toNumber(row[oi]) === 1;
    const key = other ? "\u0000other" : keyOf(row[d0]);
    const value = toNumber(row[mi]);
    let node = outer.get(key);
    if (!node) {
      node = { name: other ? seriesLabel(OTHER_LABEL, state.display) : label(row[d0], outerDim), value: null, other };
      if (innerDim && !other) node.children = [];
      if (own.has(key)) node.ownValue = own.get(key);
      outer.set(key, node);
    }
    if (node.children) {
      node.children.push({ name: label(row[d1], innerDim!), value, other: false });
      node.value = (node.value ?? 0) + (value ?? 0);
    } else {
      node.value = (node.value ?? 0) + (value ?? 0);
    }
  }
  const nodes = [...outer.values()];
  const byValue = (a: TreemapNode, b: TreemapNode) => (b.value ?? 0) - (a.value ?? 0);
  nodes.sort((a, b) => Number(a.other) - Number(b.other) || byValue(a, b));
  for (const n of nodes) n.children?.sort(byValue);
  return nodes;
}

/** Aggregates whose box sizes don't add up (a parent box would be the sum of averages). */
export function nonAdditive(state: ChartState, dataset: Dataset | null): boolean {
  const metric = state.query.metrics[0];
  if (!metric) return false;
  if (isSqlMetric(metric)) return /\b(AVG|MIN|MAX|DISTINCT|PERCENTILE|MEDIAN)\b|\//i.test(metric.sql);
  if (typeof metric !== "string") return metric.aggregate !== "SUM" && metric.aggregate !== "COUNT";
  const expression = dataset?.metrics.find((m) => m.name === metric)?.expression ?? "";
  return /\b(AVG|MIN|MAX|DISTINCT|PERCENTILE|MEDIAN)\b/i.test(expression);
}

export function treemapOption(state: ChartState, result: ChartDataResult, dataset: Dataset | null, ctx: DrawContext & { total?: ChartDataResult | null } = {}): EChartsOption {
  const metric = state.query.metrics[0];
  const format = metric ? metricFormatter(state.display, metric, dataset) : (v: unknown) => String(v);
  const nodes = treemapTree(state, result, dataset, ctx.total);
  const palette = ctx.colors?.filter(Boolean) ?? [];
  const twoLevels = state.query.dimensions.length === 2;
  const showValues = Boolean(state.display.value_labels);
  const rules = metric ? colorRules(state.display) : [];
  const tones = toneColors(ctx);
  const ruleOf = (value: unknown) => (metric && rules.length ? ruleFor(value, metricName(metric), rules) : null);
  const colorAt = (i: number, other: boolean, key: string, value: unknown) => {
    const rule = ruleOf(value);
    if (rule && tones[rule.tone]) return tones[rule.tone];
    return palette.length ? (other ? palette[8 % palette.length] : pickSeriesColor(state.display, key, i, palette)) : undefined;
  };
  type Item = {
    name: string;
    value: number;
    ownValue?: number | null;
    itemStyle?: { color?: string };
    label?: { color?: string };
    children?: Item[];
  };
  // Labels in whichever of the text / card colors reads best on the box. Children keep their
  // parent's color (told apart by the gaps and their labels), so the choice holds for them too.
  const textOn = (fill: string | undefined) => readableOn(fill, [ctx.tokens?.text, ctx.tokens?.surface]);
  const data: Item[] = nodes.map((n, i) => {
    const color = colorAt(i, n.other, n.name, n.ownValue ?? n.value);
    const label = textOn(color);
    const style = color ? { itemStyle: { color }, ...(label ? { label: { color: label } } : {}) } : {};
    return {
      name: n.name,
      value: n.value ?? 0,
      ...(n.ownValue !== undefined ? { ownValue: n.ownValue } : {}),
      ...style,
      ...(n.children ? { children: n.children.map((c) => ({ name: c.name, value: c.value ?? 0, ...style })) } : {}),
    };
  });
  const text = ctx.tokens?.text;
  return {
    tooltip: {
      formatter: (params: unknown) => {
        const p = params as { name: string; value: unknown; treePathInfo?: { name: string }[]; data?: { ownValue?: number | null; children?: unknown[] } };
        const path = (p.treePathInfo ?? []).map((x) => x.name).filter(Boolean);
        const own = p.data?.children ? p.data.ownValue : undefined;
        const value = own !== undefined && own !== null ? own : p.value;
        return `${escapeHtml(path.join(" › ") || p.name)}: <b>${escapeHtml(format(value))}</b>`;
      },
    },
    series: [
      {
        type: "treemap",
        name: metric ? metricLabel(metric, dataset) : "",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        width: "100%",
        height: "100%",
        top: 0,
        left: 0,
        label: {
          show: true,
          formatter: (p: unknown) => {
            const item = p as { name: string; value: unknown };
            // A colored box always says its value, with ▲ / ▼ (not color alone).
            const rule = ruleOf(item.value);
            if (rule) return `${item.name}\n${ruleMarker(rule)} ${format(item.value)}`;
            return showValues ? `${item.name}\n${format(item.value)}` : item.name;
          },
          fontSize: 12,
          overflow: "truncate",
          textBorderWidth: 0,
          textBorderColor: "transparent",
        },
        // Two levels: each outer box's name on a card-colored band along its top. (Level 0 is
        // the root, level 1 the outer boxes, level 2 the inner ones.)
        upperLabel: twoLevels ? { show: true, height: 22, fontSize: 12, fontWeight: 600, ...(text ? { color: text } : {}) } : undefined,
        itemStyle: { borderColor: ctx.tokens?.surface ?? "transparent", borderWidth: 2, gapWidth: 2 },
        levels: twoLevels
          ? [
              { itemStyle: { borderWidth: 0, gapWidth: 4 }, upperLabel: { show: false } },
              { itemStyle: { borderWidth: 3, gapWidth: 2, ...(ctx.tokens?.surface ? { borderColor: ctx.tokens.surface } : {}) } },
              { itemStyle: { borderWidth: 0, gapWidth: 2 } },
            ]
          : undefined,
        data,
      },
    ],
  };
}

// ---------- funnel ----------

export type FunnelStep = {
  name: string;
  /** The step's name before renames (what a custom order lists). */
  key: string;
  value: number;
  /** Share of the first step / of the step before (null for the first). */
  ofFirst: number | null;
  ofPrevious: number | null;
};

/** Rows [step, metric] -> steps in order (by value, or the chosen order with the rest after). */
export function funnelSteps(state: ChartState, result: ChartDataResult, dataset: Dataset | null): FunnelStep[] {
  const dim = state.query.dimensions[0] ?? "";
  const metric = state.query.metrics[0];
  const di = columnIndex(result, dim);
  const mi = metric ? columnIndex(result, metricName(metric)) : -1;
  const steps = result.rows.map((row) => {
    const key = dimensionLabel(row[di], dim, dataset);
    return { key, name: seriesLabel(key, state.display), value: toNumber(row[mi]) ?? 0 };
  });
  steps.sort((a, b) => b.value - a.value);
  if (state.display.funnel_order === "custom" && state.display.funnel_steps?.length) {
    const position = new Map(state.display.funnel_steps.map((k, i) => [k, i]));
    const rank = (k: string) => position.get(k) ?? Number.MAX_SAFE_INTEGER;
    steps.sort((a, b) => rank(a.key) - rank(b.key)); // stable: unlisted steps keep value order
  }
  const first = steps[0]?.value ?? 0;
  return steps.map((s, i) => ({
    ...s,
    ofFirst: i === 0 ? null : first ? s.value / first : null,
    ofPrevious: i === 0 ? null : steps[i - 1]!.value ? s.value / steps[i - 1]!.value : null,
  }));
}

const percent = (ratio: number | null) => (ratio === null ? "–" : `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`);

export function funnelOption(state: ChartState, result: ChartDataResult, dataset: Dataset | null, ctx: DrawContext = {}): EChartsOption {
  const metric = state.query.metrics[0];
  const format = metric ? metricFormatter(state.display, metric, dataset) : (v: unknown) => String(v);
  const steps = funnelSteps(state, result, dataset);
  const palette = ctx.colors?.filter(Boolean) ?? [];
  const max = Math.max(0, ...steps.map((s) => s.value));
  const rules = metric ? colorRules(state.display) : [];
  const tones = toneColors(ctx);
  const ruleOf = (value: unknown) => (metric && rules.length ? ruleFor(value, metricName(metric), rules) : null);
  const showValues = state.display.value_labels !== false;
  return {
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const { dataIndex } = params as { dataIndex: number };
        const step = steps[dataIndex]!;
        const lines = [`${escapeHtml(step.name)}: <b>${escapeHtml(format(step.value))}</b>`];
        if (step.ofFirst !== null) lines.push(`${percent(step.ofFirst)} of the first step`, `${percent(step.ofPrevious)} of the step before`);
        return lines.join("<br/>");
      },
    },
    series: [
      {
        type: "funnel",
        name: metric ? metricLabel(metric, dataset) : "",
        sort: "none",
        min: 0,
        max: max || 1,
        minSize: "8%",
        gap: 3,
        // Labels beside the steps (narrow steps would cut them; and text on the page reads
        // the same whatever the step color).
        left: "4%",
        right: "40%",
        top: 12,
        bottom: 12,
        label: {
          show: true,
          position: "right",
          formatter: (p: unknown) => {
            const step = steps[(p as { dataIndex: number }).dataIndex]!;
            const rule = ruleOf(step.value);
            if (rule) return `${step.name}\n${ruleMarker(rule)} ${format(step.value)}`;
            if (!showValues) return step.name;
            return step.ofFirst === null ? `${step.name}\n${format(step.value)}` : `${step.name}\n${format(step.value)} · ${percent(step.ofFirst)}`;
          },
          fontSize: 12,
          lineHeight: 16,
          ...(ctx.tokens?.text ? { color: ctx.tokens.text } : {}),
        },
        labelLine: { show: true, length: 14, ...(ctx.tokens?.border ? { lineStyle: { color: ctx.tokens.border } } : {}) },
        itemStyle: { borderWidth: 0 },
        emphasis: { label: { fontSize: 13 } },
        data: steps.map((s, i) => {
          const rule = ruleOf(s.value);
          const color = rule && tones[rule.tone] ? tones[rule.tone] : palette.length ? pickSeriesColor(state.display, s.key, i, palette) : undefined;
          return { name: s.name, value: s.value, ...(color ? { itemStyle: { color } } : {}) };
        }),
      },
    ],
  };
}

// ---------- gauge ----------

/** A round number at or above x (1, 2, 2.5, 5 x 10^n). */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(x));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= x) return step * power;
  return 10 * power;
}

export type GaugeScale = { min: number; max: number; target: number | null; bands: (GaugeBand & { from: number })[] };

/** Min / max / target / bands of a gauge. Max defaults to a round number above the value and
 * the target; bands are sorted, clipped to the range, and empty ones dropped. */
export function gaugeScale(value: number | null, display: ChartState["display"]): GaugeScale {
  const min = display.gauge_min ?? 0;
  const target = display.gauge_target ?? null;
  const highest = Math.max(value ?? 0, target ?? 0, ...(display.gauge_bands ?? []).map((b) => b.to));
  let max = display.gauge_max ?? (min + niceCeil((highest - min) * 1.1));
  if (!(max > min)) max = min + 1;
  const sorted = [...(display.gauge_bands ?? [])].filter((b) => Number.isFinite(b.to)).sort((a, b) => a.to - b.to);
  const bands: GaugeScale["bands"] = [];
  let from = min;
  for (const band of sorted) {
    const to = Math.min(Math.max(band.to, min), max);
    if (to > from) bands.push({ ...band, from, to });
    from = Math.max(from, to);
  }
  return { min, max, target, bands };
}

/** The tone of the band a value falls in (null: none). */
export function gaugeTone(value: number | null, scale: GaugeScale): GaugeTone | null {
  if (value === null) return null;
  return scale.bands.find((b) => value >= b.from && value <= b.to)?.tone ?? null;
}

export function gaugeOption(state: ChartState, result: ChartDataResult, dataset: Dataset | null, ctx: DrawContext = {}): EChartsOption {
  const metric = state.query.metrics[0];
  const format = metric ? metricFormatter(state.display, metric, dataset) : (v: unknown) => String(v);
  const value = toNumber(result.rows[0]?.[0]);
  const scale = gaugeScale(value, state.display);
  const t = ctx.tokens ?? {};
  const toneColor = (tone: GaugeTone) => t[tone];
  const span = scale.max - scale.min;
  const track = t.border;
  // Bands as color stops along the arc; the rest of the arc is the neutral track.
  const stops: [number, string][] = [];
  let at = 0;
  for (const band of scale.bands) {
    const from = (band.from - scale.min) / span;
    if (from > at && track) stops.push([from, track]);
    const color = toneColor(band.tone);
    if (color) stops.push([(band.to - scale.min) / span, color]);
    at = (band.to - scale.min) / span;
  }
  if (at < 1 && track) stops.push([1, track]);
  const banded = scale.bands.length > 0;
  const width = 14;
  const common = { min: scale.min, max: scale.max, startAngle: 210, endAngle: -30, radius: "88%", center: ["50%", "58%"] as [string, string] };
  const subtitle = state.display.subtitle || (metric ? metricLabel(metric, dataset) : "");
  return {
    tooltip: { show: false },
    series: [
      {
        type: "gauge",
        ...common,
        splitNumber: 4,
        progress: banded ? { show: false } : { show: true, width, roundCap: false, ...(t.accent ? { itemStyle: { color: t.accent } } : {}) },
        axisLine: { lineStyle: { width, color: stops.length ? stops : undefined } },
        pointer: banded
          ? { show: true, width: 4, length: "62%", ...(t.text ? { itemStyle: { color: t.text } } : {}) }
          : { show: false },
        anchor: banded ? { show: true, size: 10, itemStyle: { ...(t.text ? { color: t.text } : {}) } } : { show: false },
        axisTick: { distance: -width, length: 4, lineStyle: { width: 1, ...(t.surface ? { color: t.surface } : {}) } },
        splitLine: { distance: -width, length: width, lineStyle: { width: 2, ...(t.surface ? { color: t.surface } : {}) } },
        axisLabel: { distance: width + 8, fontSize: 11, formatter: (v: number) => format(v), ...(t.muted ? { color: t.muted } : {}) },
        title: { offsetCenter: [0, "62%"], fontSize: 12, ...(t.muted ? { color: t.muted } : {}) },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, "32%"],
          fontSize: 28,
          fontWeight: 500,
          formatter: () => (value === null ? "-" : format(value)),
          ...(t.text ? { color: t.text } : {}),
        },
        data: [{ value: value === null ? scale.min : Math.min(Math.max(value, scale.min), scale.max), name: subtitle }],
      },
      ...(scale.target === null
        ? []
        : [
            {
              // The target: a short marker across the arc.
              type: "gauge" as const,
              ...common,
              axisLine: { show: false },
              axisTick: { show: false },
              splitLine: { show: false },
              axisLabel: { show: false },
              progress: { show: false },
              anchor: { show: false },
              title: { show: false },
              detail: { show: false },
              pointer: {
                show: true,
                icon: "rect",
                width: 3,
                length: width + 16,
                offsetCenter: [0, "-95%"],
                ...(t.accent ? { itemStyle: { color: t.accent } } : {}),
              },
              data: [{ value: Math.min(Math.max(scale.target, scale.min), scale.max), name: "Target" }],
              z: 5,
            },
          ]),
    ],
  };
}

/** "Target 1,000 · 82% of target" under a gauge (null without a target). */
export function gaugeTargetText(state: ChartState, result: ChartDataResult, dataset: Dataset | null): string | null {
  const target = state.display.gauge_target;
  const metric = state.query.metrics[0];
  if (target === null || target === undefined || !metric) return null;
  const format = metricFormatter(state.display, metric, dataset);
  const value = toNumber(result.rows[0]?.[0]);
  const share = value !== null && target !== 0 ? ` · ${Math.round((value / target) * 100)}% of target` : "";
  return `Target ${format(target)}${share}`;
}
