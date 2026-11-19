import { BarChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, PieChart, ScatterChart, TreemapChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "../motion/useReducedMotion.ts";
import { useTheme } from "../theme/theme.ts";
import { paperVar } from "../lib/cssVar.ts";
import { motionOn } from "../motion/ignara.ts";
import { registerVitaTheme } from "./echartsTheme.ts";
import { ignaraStyle, type ChartLook, type IgnaraTokens } from "./ignaraStyle.ts";

// Bundled locally and tree-shaken: only the chart types Vita draws (the title is the donut's
// center label; mark areas shade incomplete periods of area charts; the continuous visual map
// is the color scale of heatmaps and maps). The map series registers itself with the lazy map.
echarts.use([
  HeatmapChart,
  ScatterChart,
  VisualMapContinuousComponent,
  BarChart,
  LineChart,
  PieChart,
  TreemapChart,
  FunnelChart,
  GaugeChart,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

type Props = {
  option: EChartsOption;
  className?: string;
  /** Accessible description of the chart (canvas content isn't readable). */
  label: string;
  /** A click on a series element (bar, slice, box, country...): ECharts' event params. */
  onItemClick?: (params: EChartClick) => void;
  /** Ignara components drawn on top of the option (lollipops, the dial, legend chips...). */
  look?: ChartLook;
};

/** What a click on a chart element tells (the parts Vita reads). */
export type EChartClick = { dataIndex: number; seriesIndex?: number; name?: string; data?: unknown };

/** An ECharts instance that follows its container's size and the Vita theme. Switching the
 * theme (or the reduced-motion setting) rebuilds the chart: ECharts 5 can't re-theme a live one. */
/** The tokens the Ignara look draws with (canvas can't read CSS variables). */
const tokens = (): IgnaraTokens => ({
  surface: paperVar("--surface"),
  surface2: paperVar("--surface-2"),
  surface3: paperVar("--surface-3"),
  data: paperVar("--data"),
  text: paperVar("--text"),
  accent: paperVar("--accent"),
  accentFrom: paperVar("--accent-from"),
  accentTo: paperVar("--accent-to"),
  accentSoft: paperVar("--accent-soft"),
  accentGlow: paperVar("--accent-glow"),
  accentFg: paperVar("--accent-fg"),
});

/** The option as drawn: Ignara's series look and entrances on top of what the builders made. */
const styled = (option: EChartsOption, reducedMotion: boolean, look: ChartLook | undefined) =>
  ignaraStyle(option, tokens(), !reducedMotion && motionOn(), look);

export default function EChart({ option, className, label, onItemClick, look }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const lookRef = useRef(look);
  lookRef.current = look;
  const lookKey = JSON.stringify(look ?? {});
  const clickRef = useRef(onItemClick);
  clickRef.current = onItemClick;
  const { resolved } = useTheme();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const instance = echarts.init(el, registerVitaTheme(resolved, reducedMotion));
    chart.current = instance;
    instance.setOption(styled(optionRef.current, reducedMotion, lookRef.current), { notMerge: true });
    instance.on("click", (params) => {
      const p = params as unknown as EChartClick & { componentType?: string };
      if (p.componentType === "series") clickRef.current?.(p);
    });
    // At most one resize per animation frame (a dashboard tile being resized fires many).
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => instance.resize());
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [resolved, reducedMotion]);

  useEffect(() => {
    chart.current?.setOption(styled(option, reducedMotion, lookRef.current), { notMerge: true });
    // reducedMotion: the first effect rebuilds the chart when it changes; the look by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option, lookKey]);

  return <div ref={ref} className={className ?? "echart"} role="img" aria-label={label} />;
}
