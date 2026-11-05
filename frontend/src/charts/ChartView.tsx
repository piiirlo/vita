import { useMemo } from "react";
import type { ChartDataResult, Dataset } from "../api.ts";
import EChart from "./EChart.tsx";
import { formatNumber } from "./format.ts";
import { metricFormat, metricLabel, type ChartState } from "./model.ts";
import { cartesianOption, sparklineOption } from "./options.ts";
import TableChart from "./TableChart.tsx";

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
          {formatNumber(value, metric ? metricFormat(metric, dataset) : null)}
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
