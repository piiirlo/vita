import { useMemo } from "react";
import type { ChartDataResult, Dataset } from "../api.ts";
import EChart from "./EChart.tsx";
import { formatNumber } from "./format.ts";
import { metricFormat, metricLabel, type ChartState } from "./model.ts";
import { cartesianOption, sparklineOption } from "./options.ts";
import TableChart from "./TableChart.tsx";
import { CountUp } from "../components/motion.tsx";
import { toNumber } from "./format.ts";

type Props = {
  state: ChartState;
  result: ChartDataResult;
  trend: ChartDataResult | null;
  dataset: Dataset | null;
};

/** Draws a chart from chart-data results. The caller handles loading / error states. */
export default function ChartView({ state, result, trend, dataset }: Props) {
  const option = useMemo(
    () => (state.vizType === "bar" || state.vizType === "line" ? cartesianOption(state, result, dataset) : null),
    [state, result, dataset],
  );

  if (result.rows.length === 0) return <p className="chart-empty">No data</p>;

  if (state.vizType === "table") return <TableChart state={state} result={result} dataset={dataset} />;

  if (state.vizType === "big_number") {
    const metric = state.query.metrics[0];
    const value = result.rows[0]?.[0];
    return (
      <div className="big-number">
        <div className="big-number-value" data-testid="big-number-value">
          <BigValue value={value} format={metric ? metricFormat(metric, dataset) : null} />
        </div>
        <div className="big-number-subtitle">
          {state.display.subtitle || (metric ? metricLabel(metric, dataset) : "")}
        </div>
        {trend && trend.rows.length > 1 && (
          <EChart className="big-number-trend" option={sparklineOption(state, trend, dataset)} label="Trend" />
        )}
      </div>
    );
  }

  return (
    <EChart
      option={option!}
      label={`${state.vizType === "bar" ? "Bar" : "Line"} chart of ${state.query.metrics
        .map((m) => metricLabel(m, dataset))
        .join(", ")}`}
    />
  );
}

/** "$319,470.51" with the decimals in the accent color (like the mockup). */
function splitDecimals(text: string) {
  const m = /^(.*\d)(\.\d+)(\D*)$/.exec(text);
  if (!m) return text;
  return (
    <>
      {m[1]}
      <span className="big-number-frac">{m[2]}</span>
      {m[3]}
    </>
  );
}

/** The big number counts up from 0 the first time it is shown. */
function BigValue({ value, format }: { value: unknown; format: string | null }) {
  const n = toNumber(value);
  if (n === null) return <>{formatNumber(value, format)}</>;
  return <CountUp value={n} format={(x) => formatNumber(x, format)} render={splitDecimals} />;
}
