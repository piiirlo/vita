/**
 * Ignara's chart look and entrances, applied to every ECharts option just before it is drawn
 * (EChart.tsx), so the 15 chart builders stay as they are. Pure: returns a new option.
 *
 * From Ignara's chart code (its charts are hand-built SVG animated with GSAP):
 * - lines: a smooth curve, 2.4px, round caps; an area fills with a gradient of its color
 *   (26% → 0); the line draws in 1.2s power2.inOut, a comparison line fades in after 0.6s;
 *   hovering shows a 10px dot filled with the page color, ringed in the series color.
 * - bars: 8px top corners (3px at the base), grow from the base in 1.1s expo.out, staggered
 *   0.5s / n after 0.2s; horizontal bars 1s, 0.07s apart; a hovered bar glows.
 * - heatmap cells: 6px corners, pop in with back.out, 12ms apart.
 * - funnel steps and other shares: 0.09s apart after 0.25s; gauges sweep in 1.4s after 0.6s.
 * Updates morph with expo.inOut (the theme). Nothing here re-enables animation that the
 * theme turned off (reduced motion): `motion` false leaves timings alone.
 */
import type { EChartsOption } from "echarts";

export type IgnaraTokens = {
  /** The card the chart sits on (hover dot fill, borders between cells / slices). */
  surface?: string;
  /** card-2: the rails of horizontal bars. */
  surface2?: string;
  /** card-3: beads, the dial's track. */
  surface3?: string;
  /** Quiet data (stems, bead rings). */
  data?: string;
  text?: string;
  accent?: string;
  accentFrom?: string;
  accentTo?: string;
  accentSoft?: string;
  accentGlow?: string;
  accentFg?: string;
};

/** Ignara components drawn on top of what a builder made (EChart's `look`). */
export type ChartLook = {
  /** A big number's trend line: Ignara's squiggle (no fill, drawn after 0.3s). */
  sparkline?: boolean;
  /** Bars as lollipops (stem + bead), with an optional target line. */
  lollipop?: { target: number | null; latest?: boolean };
  /** A gauge as Ignara's dial: 44 ticks over 270°, the lit ones in ember. */
  dial?: boolean;
  /** Series hidden by the legend chips. */
  hiddenSeries?: string[];
  /** The legend is drawn as chips by the page: hide the chart's own. */
  chipLegend?: boolean;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** rgba() of a hex color at `alpha` (other color strings are returned as they are). */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const gradient = (color: string) => ({
  type: "linear" as const,
  x: 0,
  y: 0,
  x2: 0,
  y2: 1,
  colorStops: [
    { offset: 0, color: withAlpha(color, 0.26) },
    { offset: 1, color: withAlpha(color, 0) },
  ],
});

function isHorizontal(option: Obj): boolean {
  const y = asArray(option.yAxis as Obj | Obj[] | undefined)[0];
  return isObj(y) && y.type === "category";
}

function dataLength(series: Obj): number {
  return Array.isArray(series.data) ? series.data.length : 0;
}

function styleSeries(series: Obj, option: Obj, tokens: IgnaraTokens, motion: boolean): Obj {
  const s: Obj = { ...series };
  const itemStyle = isObj(s.itemStyle) ? s.itemStyle : {};
  const lineStyle = isObj(s.lineStyle) ? s.lineStyle : {};
  const color = (itemStyle.color ?? lineStyle.color) as string | undefined;
  const timing = (t: Obj) => (motion ? Object.assign(s, t) : s);

  switch (s.type) {
    case "line": {
      const comparison = lineStyle.type === "dotted" || lineStyle.type === "dashed";
      if (s.smooth === undefined && !s.step) s.smooth = 0.35;
      s.lineStyle = { width: 2.4, cap: "round", join: "round", ...lineStyle };
      if (isObj(s.areaStyle) && !s.stack && typeof color === "string") s.areaStyle = { ...s.areaStyle, opacity: 1, color: gradient(color) };
      if (!s.showSymbol) s.symbolSize = s.symbolSize ?? 10;
      if (typeof color === "string")
        s.emphasis = {
          ...(isObj(s.emphasis) ? s.emphasis : {}),
          scale: false,
          itemStyle: { color: tokens.surface ?? color, borderColor: color, borderWidth: 2.5 },
        };
      timing(
        comparison
          ? { animationDuration: 600, animationDelay: 600, animationEasing: "linear" }
          : { animationDuration: 1200, animationEasing: "cubicInOut" },
      );
      break;
    }
    case "bar": {
      const horizontal = isHorizontal(option);
      if (horizontal && !s.stack) {
        // Ignara's hbars: a 10px rounded rail on a card-2 track, the fill a gradient of its
        // color (55% → 100%) with a soft glow, the value at the end of the row.
        s.barWidth = 10;
        s.barMaxWidth = undefined;
        s.showBackground = true;
        s.backgroundStyle = { color: tokens.surface2 ?? "transparent", borderRadius: 10 };
        s.itemStyle = {
          ...itemStyle,
          borderRadius: 10,
          ...(typeof color === "string"
            ? {
                color: { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: withAlpha(color, 0.55) }, { offset: 1, color }] },
                shadowBlur: 10,
                shadowColor: withAlpha(color, 0.5),
              }
            : {}),
        };
        if (isObj(s.label) && s.label.show) s.label = { ...s.label, position: "right", distance: 10, fontWeight: 700, ...(tokens.text ? { color: tokens.text } : {}) };
      } else if (!s.stack) s.itemStyle = { borderRadius: [8, 8, 3, 3], ...itemStyle };
      if (typeof color === "string")
        s.emphasis = {
          ...(isObj(s.emphasis) ? s.emphasis : {}),
          itemStyle: { shadowBlur: 14, shadowOffsetY: 6, shadowColor: withAlpha(color, 0.55) },
        };
      const n = Math.max(1, dataLength(s));
      timing(
        horizontal
          ? { animationDuration: 1000, animationEasing: "exponentialOut", animationDelay: (i: number) => 200 + i * 70 }
          : { animationDuration: 1100, animationEasing: "exponentialOut", animationDelay: (i: number) => 200 + i * (500 / n) },
      );
      break;
    }
    case "heatmap":
      s.itemStyle = { borderRadius: 6, borderWidth: 3, ...(tokens.surface ? { borderColor: tokens.surface } : {}), ...itemStyle };
      timing({ animationDuration: 600, animationEasing: "backOut", animationDelay: (i: number) => Math.min(i * 12, 900) });
      break;
    case "scatter":
      timing({ animationDuration: 600, animationEasing: "backOut", animationDelay: (i: number) => Math.min(i * 8, 600) });
      break;
    case "pie":
      if (tokens.surface && itemStyle.borderColor === "transparent") s.itemStyle = { ...itemStyle, borderColor: tokens.surface };
      timing({ animationDuration: 1000, animationEasing: "exponentialOut", animationDelay: 250 });
      break;
    case "funnel":
      timing({ animationDuration: 800, animationEasing: "exponentialOut", animationDelay: (i: number) => 250 + i * 90 });
      break;
    case "gauge":
      timing({ animationDuration: 1400, animationEasing: "exponentialOut", animationDelay: 600 });
      break;
    case "treemap":
      timing({ animationDuration: 1100, animationEasing: "exponentialOut" });
      break;
    default:
      timing({ animationDuration: 800, animationEasing: "exponentialOut" });
  }
  return s;
}

/** The option with Ignara's look on every series (see the file comment), and the `look`
 * components (lollipops, the dial, the squiggle, chip legends). */
export function ignaraStyle(option: EChartsOption, tokens: IgnaraTokens, motion: boolean, look: ChartLook = {}): EChartsOption {
  let o = option as Obj;
  if (!o.series) return option;
  if (look.dial) o = dial(o, tokens);
  if (look.lollipop) o = lollipop(o, tokens, look.lollipop.target, look.lollipop.latest ?? false);
  const raw: unknown = o.series;
  let series = (Array.isArray(raw) ? (raw as unknown[]) : [raw]).map((s) => (isObj(s) ? styleSeries(s, o, tokens, motion) : s));
  if (look.sparkline)
    series = series.map((s) =>
      isObj(s) && s.type === "line" && !(isObj(s.lineStyle) && s.lineStyle.type)
        ? { ...s, areaStyle: undefined, smooth: 0.35, ...(motion ? { animationDelay: 300, animationDuration: 1200, animationEasing: "cubicInOut" } : {}) }
        : s,
    );
  if (look.lollipop && motion) series = series.map((s) => (isObj(s) && s.type === "scatter" ? { ...s, ...beadTiming(s) } : s));
  const out: Obj = { ...o, series: Array.isArray(raw) ? series : series[0] };
  // Horizontal bars: the row names read like Ignara's (13.5px, semibold).
  if (isHorizontal(o) && asArray(o.series as Obj | Obj[]).some((x) => isObj(x) && x.type === "bar")) {
    const y = asArray(o.yAxis as Obj | Obj[] | undefined);
    const grid = asArray(o.grid as Obj | Obj[] | undefined)[0];
    const labelled = asArray(o.series as Obj | Obj[]).some((x) => isObj(x) && isObj(x.label) && x.label.show);
    if (labelled && grid && (typeof grid.right !== "number" || grid.right < 84)) out.grid = { ...grid, right: 84 };
    out.yAxis = y.map((axis, i) =>
      i === 0 && isObj(axis) ? { ...axis, axisLine: { show: false }, axisLabel: { ...(isObj(axis.axisLabel) ? axis.axisLabel : {}), fontSize: 13, fontWeight: 600, ...(tokens.text ? { color: tokens.text } : {}) } } : axis,
    );
  }
  if (look.chipLegend || look.hiddenSeries?.length) {
    const legend = asArray(o.legend as Obj | Obj[] | undefined)[0] ?? {};
    out.legend = {
      ...legend,
      show: look.chipLegend ? false : legend.show,
      selected: Object.fromEntries((look.hiddenSeries ?? []).map((name) => [name, false])),
    };
    // The chips sit above the chart: give back the room a top legend had.
    const grid = asArray(o.grid as Obj | Obj[] | undefined)[0];
    if (look.chipLegend && grid && grid.top === 48) out.grid = { ...grid, top: 24 };
  }
  return out;
}

// ---------- lollipop (Ignara's "beads": stem + bead, ember at or above the target) ----------

const valueOf = (d: unknown): number | null => {
  const v = isObj(d) ? d.value : d;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

/** Beads ride up with their stems: same stagger, same easing. */
function beadTiming(s: Obj): Obj {
  const n = Math.max(1, dataLength(s));
  return { animationDuration: 1100, animationEasing: "exponentialOut", animationDelay: (i: number) => 200 + i * (500 / n) };
}

/** A stem: transparent at the base, the color from 40% up (Ignara's linear-gradient(to top,
 * transparent, var(--data) 40%)). */
const stemFill = (from: string, to: string, at = 0.4) => ({
  type: "linear" as const,
  x: 0,
  y: 1,
  x2: 0,
  y2: 0,
  colorStops: [
    { offset: 0, color: withAlpha(from, 0) },
    { offset: at, color: from },
    { offset: 1, color: to },
  ],
});

/** `latest`: the x axis is time, so the last bead is "today" (ink). */
function lollipop(o: Obj, t: IgnaraTokens, target: number | null, latest: boolean): Obj {
  const all = asArray(o.series as Obj | Obj[]);
  const bars = all.filter((s) => isObj(s) && s.type === "bar");
  if (bars.length !== 1) return o;
  const bar = bars[0]!;
  const data = (Array.isArray(bar.data) ? bar.data : []) as unknown[];
  const dense = data.length > 20;
  const base = t.data ?? "#888888";
  const over = (v: number | null) => target !== null && v !== null && v >= target;
  const last = data.length - 1;
  const stems: Obj[] = [];
  const beads: Obj[] = [];
  data.forEach((d, i) => {
    const item: Obj = isObj(d) ? d : { value: d };
    const own = isObj(item.itemStyle) && typeof item.itemStyle.color === "string" ? item.itemStyle.color : null;
    const v = valueOf(d);
    const hot = !own && over(v);
    const color = own ?? base;
    stems.push({
      ...item,
      label: { show: false },
      itemStyle: {
        ...(isObj(item.itemStyle) ? item.itemStyle : {}),
        borderRadius: 6,
        color: hot && t.accentTo && t.accentFrom ? stemFill(t.accentTo, t.accentFrom, 0.35) : stemFill(color, color),
      },
    });
    const today = latest && i === last && !hot && !own;
    beads.push({
      value: item.value,
      itemStyle: hot
        ? { color: t.accentFrom ?? color, borderColor: t.accentSoft ?? color, borderWidth: 4, shadowBlur: 16, shadowColor: t.accentGlow ?? color }
        : today
          ? { color: t.text ?? color, borderColor: t.surface3 ?? color, borderWidth: 3 }
          : { color: t.surface3 ?? "transparent", borderColor: color, borderWidth: dense ? 2.5 : 3 },
    });
  });
  const format = isObj(bar.label) && typeof bar.label.formatter === "function" ? (bar.label.formatter as (p: { value: number }) => unknown) : null;
  const stemSeries: Obj = {
    ...bar,
    barWidth: dense ? 4 : 6,
    barMaxWidth: undefined,
    data: stems,
    label: { show: false },
    emphasis: { disabled: true },
    ...(target !== null
      ? {
          markLine: {
            silent: true,
            symbol: "none",
            animationDuration: 1000,
            animationDelay: 500,
            animationEasing: "exponentialOut",
            lineStyle: { type: [5, 4], width: 1.5, color: t.accent ?? base, opacity: 0.85 },
            label: {
              position: "start",
              formatter: () => (format ? String(format({ value: target })) : String(target)),
              color: t.accentFg ?? "#000000",
              backgroundColor: t.accent ?? base,
              borderRadius: 7,
              padding: [2, 8],
              fontSize: 11,
              fontWeight: 700,
            },
            data: [{ yAxis: target }],
          },
        }
      : {}),
  };
  const beadSeries: Obj = {
    type: "scatter",
    name: bar.name,
    id: `bead:${String(bar.id ?? bar.name ?? "")}`,
    data: beads,
    symbol: "circle",
    symbolSize: dense ? 10 : 14,
    z: 3,
    ...(bar.yAxisIndex !== undefined ? { yAxisIndex: bar.yAxisIndex } : {}),
    label: isObj(bar.label) && bar.label.show ? { ...bar.label, position: "top", distance: 10 } : { show: false },
    tooltip: { show: false },
    emphasis: { scale: 1.25 },
  };
  const series = [...all];
  series.splice(all.indexOf(bar), 1, stemSeries, beadSeries);
  return { ...o, series };
}

// ---------- gauge: Ignara's dial ----------

const DIAL_TICKS = 44;

/** Ignara's dial: 44 ticks over 270° (from -225°), card-3; the first `share × 44` lit in an
 * ember gradient (or the color of the band the value is in). The value in the middle. */
function dial(o: Obj, t: IgnaraTokens): Obj {
  const all = asArray(o.series as Obj | Obj[]);
  const main = all[0];
  if (!isObj(main) || main.type !== "gauge") return o;
  const min = typeof main.min === "number" ? main.min : 0;
  const max = typeof main.max === "number" ? main.max : 100;
  const point: Obj = Array.isArray(main.data) && isObj(main.data[0]) ? main.data[0] : {};
  const value = typeof point.value === "number" ? point.value : min;
  const share = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const lit = Math.round(share * DIAL_TICKS);
  const stops =
    isObj(main.axisLine) && isObj(main.axisLine.lineStyle) && Array.isArray(main.axisLine.lineStyle.color)
      ? (main.axisLine.lineStyle.color as [number, string][])
      : null;
  const banded = isObj(main.pointer) && main.pointer.show === true;
  const bandColor = banded && stops ? (stops.find(([at]) => share <= at)?.[1] ?? null) : null;
  const ember = bandColor ?? {
    type: "linear" as const,
    x: 0,
    y: 1,
    x2: 1,
    y2: 0,
    colorStops: [
      { offset: 0, color: t.accentTo ?? t.accent ?? "#e5432c" },
      { offset: 1, color: t.accentFrom ?? t.accent ?? "#ff7b3a" },
    ],
  };
  const ring: Obj = {
    type: "gauge",
    startAngle: 225,
    radius: "92%",
    center: ["50%", "50%"],
    min: 0,
    max: 1,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { show: false },
    pointer: { show: false },
    anchor: { show: false },
    progress: { show: false },
    title: { show: false },
    detail: { show: false },
    silent: true,
  };
  const ticks = (count: number, color: unknown): Obj => ({
    ...ring,
    endAngle: 225 - (270 * Math.max(1, count - 1)) / (DIAL_TICKS - 1),
    splitNumber: Math.max(1, count - 1),
    splitLine: { show: true, distance: 0, length: "17%", lineStyle: { width: 2.6, cap: "round", color } },
    data: [{ value: 0 }],
  });
  const title = isObj(main.title) ? main.title : {};
  const track: Obj = {
    ...ticks(DIAL_TICKS, t.surface3 ?? "#cccccc"),
    title: { show: true, offsetCenter: [0, "22%"], fontSize: 11, fontWeight: 600, width: 90, overflow: "truncate", ...(title.color ? { color: title.color } : {}) },
    detail: { ...(isObj(main.detail) ? main.detail : {}), show: true, offsetCenter: [0, "-6%"], fontSize: 26, fontWeight: 600, valueAnimation: false },
    data: [{ value: 0, name: typeof point.name === "string" ? point.name : "" }],
  };
  const on = lit > 0 ? [{ ...ticks(lit, ember), z: 3 }] : [];
  // The target: one longer ink tick across the ring.
  const target = all[1];
  const goal = isObj(target) && Array.isArray(target.data) && isObj(target.data[0]) && typeof target.data[0].value === "number" ? target.data[0].value : null;
  const marker =
    goal !== null && max > min
      ? (() => {
          const angle = 225 - 270 * Math.max(0, Math.min(1, (goal - min) / (max - min)));
          return [
            {
              ...ring,
              startAngle: angle,
              endAngle: angle - 0.01,
              splitNumber: 1,
              splitLine: { show: true, distance: -4, length: "25%", lineStyle: { width: 3.5, cap: "round", color: t.text ?? "#000000" } },
              data: [{ value: 0 }],
              z: 5,
            },
          ];
        })()
      : [];
  return { ...o, series: [track, ...on, ...marker] };
}
