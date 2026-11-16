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
import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTheme } from "../theme/theme.ts";
import { registerVitaTheme } from "./echartsTheme.ts";

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
};

/** What a click on a chart element tells (the parts Vita reads). */
export type EChartClick = { dataIndex: number; seriesIndex?: number; name?: string; data?: unknown };

/** An ECharts instance that follows its container's size and the Vita theme. Switching the
 * theme (or the reduced-motion setting) rebuilds the chart: ECharts 5 can't re-theme a live one. */
export default function EChart({ option, className, label, onItemClick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const clickRef = useRef(onItemClick);
  clickRef.current = onItemClick;
  const { resolved } = useTheme();
  const reducedMotion = useReducedMotion() ?? false;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const instance = echarts.init(el, registerVitaTheme(resolved, reducedMotion));
    chart.current = instance;
    instance.setOption(optionRef.current, { notMerge: true });
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
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} className={className ?? "echart"} role="img" aria-label={label} />;
}
