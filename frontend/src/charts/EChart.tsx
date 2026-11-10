import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTheme } from "../theme/theme.ts";
import { registerVitaTheme } from "./echartsTheme.ts";

// Bundled locally and tree-shaken: only what bar / line charts need.
echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type Props = {
  option: EChartsOption;
  className?: string;
  /** Accessible description of the chart (canvas content isn't readable). */
  label: string;
};

/** An ECharts instance that follows its container's size and the Vita theme. Switching the
 * theme (or the reduced-motion setting) rebuilds the chart: ECharts 5 can't re-theme a live one. */
export default function EChart({ option, className, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const { resolved } = useTheme();
  const reducedMotion = useReducedMotion() ?? false;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const instance = echarts.init(el, registerVitaTheme(resolved, reducedMotion));
    chart.current = instance;
    instance.setOption(optionRef.current, { notMerge: true });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    return () => {
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
