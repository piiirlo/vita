import { ArrowDown, ArrowUp, TriangleAlert } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChartDataResult, Dataset } from "../api.ts";
import { CountUp } from "../components/motion.tsx";
import { cssVar } from "../lib/cssVar.ts";
import { useTheme } from "../theme/theme.ts";
import { changeRatio, hasTimeAxis, metricFormatter, type Coverage } from "./display.ts";
import EChart from "./EChart.tsx";
import { seriesColors } from "./echartsTheme.ts";
import EmptyRange from "./EmptyRange.tsx";
import { hasTimeRange } from "./emptyRange.ts";
import { useTimeExtent } from "./extentCache.ts";
import { categoryLabel, formatBucket, toNumber } from "./format.ts";
import { metricLabel, PIE_MAX_READABLE, type ChartState } from "./model.ts";
import { funnelOption, gaugeOption, gaugeTargetText, nonAdditive, treemapOption } from "./moreCharts.ts";
import { cartesianLayout, pieOption, sparklineOption, type DrawContext, type DrawToken } from "./options.ts";
import PivotTable from "./PivotTable.tsx";
import TableChart from "./TableChart.tsx";

/** Bar-like charts with a category or time x axis. */
const CARTESIAN = new Set(["bar", "line", "area", "combo"]);

/** How long the size must stay still before labels are laid out again. */
const RESIZE_SETTLE_MS = 150;

type Props = {
  state: ChartState;
  result: ChartDataResult;
  trend: ChartDataResult | null;
  /** Big number: the same metric over the period before (for "vs previous period"). */
  previous?: ChartDataResult | null;
  dataset: Dataset | null;
  /** Clears the time range ("Show all time" on an empty result). */
  onShowAllTime?: () => void;
  /** Turns on horizontal bars (offered when many long labels don't fit). */
  onMakeHorizontal?: () => void;
  /** Donut: the metric over everything (center label). */
  total?: ChartDataResult | null;
  /** Editor hints (e.g. "too many slices"); dashboards leave them out. */
  showHints?: boolean;
};

/** Width of an element (0 until measured, e.g. in tests). Changes are applied once the size
 * settles, so a tile being resized doesn't rebuild its chart on every pointer move (ECharts
 * itself follows the size every frame). */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(el.clientWidth), RESIZE_SETTLE_MS);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

/** Real colors for the canvas, re-read when the theme changes. */
function useDrawColors(): Pick<DrawContext, "colors" | "labelColor" | "tokens"> {
  const { resolved } = useTheme();
  return useMemo(
    () => ({
      colors: seriesColors(),
      labelColor: cssVar("--text-muted"),
      tokens: Object.fromEntries(
        (
          [
            ["text", "--text"],
            ["muted", "--text-muted"],
            ["border", "--border-strong"],
            ["band", "--hover"],
            ["danger", "--danger"],
            ["warning", "--series-5"], // ochre: an amber band
            ["success", "--success"],
            ["accent", "--accent"],
            ["surface", "--surface"],
          ] as [DrawToken, string][]
        ).map(([k, v]) => [k, cssVar(v)]),
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the tokens change with the theme
    [resolved],
  );
}

/** Draws a chart from chart-data results. The caller handles loading / error states. */
export default function ChartView({
  state,
  result,
  trend,
  previous = null,
  total = null,
  dataset,
  onShowAllTime,
  onMakeHorizontal,
  showHints = false,
}: Props) {
  const { vizType, query } = state;
  const [boxRef, width] = useWidth();
  const drawColors = useDrawColors();
  // Incomplete first / last periods need to know where the data is.
  const timeColumn = query.time?.column ?? null;
  const needsExtent = (CARTESIAN.has(vizType) && hasTimeAxis(state)) || (vizType === "big_number" && trend !== null);
  const extent = useTimeExtent(dataset?.id ?? null, timeColumn, needsExtent && result.rows.length > 0);
  const coverage: Coverage = useMemo(
    () => ({
      rangeStart: (trend ?? result).range_start,
      rangeEnd: (trend ?? result).range_end,
      dataMin: extent?.min,
      dataMax: extent?.max,
    }),
    [result, trend, extent],
  );

  const layout = useMemo(
    () =>
      CARTESIAN.has(vizType)
        ? cartesianLayout(state, result, dataset, { ...drawColors, width, coverage })
        : null,
    [state, result, dataset, drawColors, width, coverage, vizType],
  );

  let body: ReactNode;
  if (result.rows.length === 0) {
    // No rows (the API also returns none for a total whose time range had no rows, so a real
    // 0 and "no data" never look the same).
    const empty =
      dataset && hasTimeRange(result.range_start, result.range_end) ? (
        <EmptyRange
          datasetId={dataset.id}
          column={timeColumn}
          start={result.range_start}
          end={result.range_end}
          onShowAllTime={onShowAllTime}
        />
      ) : (
        <p className="chart-empty">No data</p>
      );
    body = vizType === "big_number" || vizType === "gauge" ? <EmptyBigNumber state={state} dataset={dataset} message={empty} /> : empty;
  } else if (vizType === "table") {
    body = <TableChart state={state} result={result} dataset={dataset} />;
  } else if (vizType === "pie") {
    body = <PieView state={state} result={result} total={total} dataset={dataset} drawColors={drawColors} showHints={showHints} />;
  } else if (vizType === "big_number") {
    body = <BigNumber state={state} result={result} trend={trend} previous={previous} dataset={dataset} coverage={coverage} drawColors={drawColors} />;
  } else if (vizType === "pivot_table") {
    body = <PivotTable state={state} result={result} dataset={dataset} />;
  } else if (vizType === "treemap") {
    body = <TreemapView state={state} result={result} total={total} dataset={dataset} drawColors={drawColors} showHints={showHints} />;
  } else if (vizType === "funnel") {
    body = <FunnelView state={state} result={result} dataset={dataset} drawColors={drawColors} />;
  } else if (vizType === "gauge") {
    body = <GaugeView state={state} result={result} dataset={dataset} drawColors={drawColors} />;
  } else {
    const plan = layout!.labels;
    // Dates run in order, so skipping some date labels hides nothing; category labels are
    // never skipped or cut without saying so.
    const notice = hasTimeAxis(state)
      ? null
      : plan.crowded
        ? `Not every label fits; hover a ${vizType === "bar" || vizType === "combo" ? "bar" : "point"} for its name.`
        : plan.suggestHorizontal && vizType === "bar"
          ? plan.truncated
            ? "Long labels are cut; hover a bar for its full name. Horizontal bars have room for them."
            : "Many long labels: horizontal bars may be easier to read."
          : null;
    body = (
      <>
        <EChart
          option={layout!.option}
          label={`${CHART_NAMES[vizType] ?? "Chart"} of ${query.metrics.map((m) => metricLabel(m, dataset)).join(", ")}${
            layout!.partial.size ? ` (${vizType === "area" ? "shaded" : "dotted or lighter"}: incomplete period)` : ""
          }`}
        />
        {notice && (
          <p className="chart-notice" role="note">
            <TriangleAlert size={14} aria-hidden />
            <span>{notice}</span>
            {vizType === "bar" && onMakeHorizontal && (
              <button type="button" className="small" onClick={onMakeHorizontal}>
                Make horizontal
              </button>
            )}
          </p>
        )}
      </>
    );
  }

  return (
    <div ref={boxRef} className={`chart-view chart-view-${vizType}`}>
      {body}
    </div>
  );
}

function BigNumber({
  state,
  result,
  trend,
  previous,
  dataset,
  coverage,
  drawColors,
}: {
  state: ChartState;
  result: ChartDataResult;
  trend: ChartDataResult | null;
  previous: ChartDataResult | null;
  dataset: Dataset | null;
  coverage: Coverage;
  drawColors: Pick<DrawContext, "colors" | "labelColor">;
}) {
  const { display, query } = state;
  const metric = query.metrics[0];
  const value = result.rows[0]?.[0];
  const format = metric ? metricFormatter(display, metric, dataset) : (v: unknown) => String(v);
  const n = toNumber(value);
  const below = display.color_below ?? null;
  const above = display.color_above ?? null;
  const status = n === null ? null : below !== null && n < below ? "below" : above !== null && n > above ? "above" : null;
  const grain = query.time?.grain ?? null;
  const trendOption = useMemo(
    () => (trend && trend.rows.length > 1 ? sparklineOption(state, trend, dataset, { ...drawColors, coverage }) : null),
    [state, trend, dataset, drawColors, coverage],
  );

  return (
    <div className={`big-number big-number-size-${display.font_size ?? "auto"}`}>
      <div className={`big-number-value${status ? ` is-${status}` : ""}`} data-testid="big-number-value">
        <BigValue value={value} format={format} />
      </div>
      {status && (
        <div className={`big-number-status is-${status}`} data-testid="big-number-status">
          {status === "below" ? <ArrowDown size={14} aria-hidden /> : <ArrowUp size={14} aria-hidden />}
          {status === "below" ? `Below ${format(below)}` : `Above ${format(above)}`}
        </div>
      )}
      <div className="big-number-subtitle">{display.subtitle || (metric ? metricLabel(metric, dataset) : "")}</div>
      {display.compare_previous && previous && <Comparison value={value} previous={previous} format={format} />}
      {trendOption && (
        <>
          <EChart className="big-number-trend" option={trendOption} label="Trend" />
          {display.trend_dates && trend && (
            <div className="big-number-trend-dates" data-testid="trend-dates">
              <span>{categoryLabel(trend.rows[0]?.[0], grain)}</span>
              <span>{categoryLabel(trend.rows.at(-1)?.[0], grain)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const CHART_NAMES: Partial<Record<ChartState["vizType"], string>> = { bar: "Bar chart", line: "Line chart", area: "Area chart", combo: "Combo chart" };

type DrawColors = Pick<DrawContext, "colors" | "labelColor" | "tokens">;

function TreemapView({
  state,
  result,
  total,
  dataset,
  drawColors,
  showHints,
}: {
  state: ChartState;
  result: ChartDataResult;
  total: ChartDataResult | null;
  dataset: Dataset | null;
  drawColors: DrawColors;
  showHints: boolean;
}) {
  const option = useMemo(() => treemapOption(state, result, dataset, { ...drawColors, total }), [state, result, dataset, drawColors, total]);
  const metric = state.query.metrics[0];
  const hint = showHints && state.query.dimensions.length === 2 && nonAdditive(state, dataset);
  return (
    <>
      <EChart option={option} label={`Treemap of ${metric ? metricLabel(metric, dataset) : ""}`} />
      {hint && (
        <p className="chart-notice" role="note">
          <TriangleAlert size={14} aria-hidden />
          <span>Box sizes add up their parts, which isn't meaningful for this metric. Hover a group for its real value, or use a sum or count.</span>
        </p>
      )}
    </>
  );
}

function FunnelView({ state, result, dataset, drawColors }: { state: ChartState; result: ChartDataResult; dataset: Dataset | null; drawColors: DrawColors }) {
  const option = useMemo(() => funnelOption(state, result, dataset, drawColors), [state, result, dataset, drawColors]);
  const metric = state.query.metrics[0];
  return <EChart option={option} label={`Funnel of ${metric ? metricLabel(metric, dataset) : ""}`} />;
}

function GaugeView({ state, result, dataset, drawColors }: { state: ChartState; result: ChartDataResult; dataset: Dataset | null; drawColors: DrawColors }) {
  const option = useMemo(() => gaugeOption(state, result, dataset, drawColors), [state, result, dataset, drawColors]);
  const metric = state.query.metrics[0];
  const value = result.rows[0]?.[0];
  const format = metric ? metricFormatter(state.display, metric, dataset) : (v: unknown) => String(v);
  const target = gaugeTargetText(state, result, dataset);
  return (
    <div className="gauge">
      <EChart option={option} label={`Gauge: ${metric ? metricLabel(metric, dataset) : ""} ${format(value)}${target ? `, ${target}` : ""}`} />
      {target && (
        <p className="gauge-target mono" data-testid="gauge-target">
          {target}
        </p>
      )}
    </div>
  );
}

/** A big number with no data: "-" instead of a number (never 0), then why. */
function EmptyBigNumber({ state, dataset, message }: { state: ChartState; dataset: Dataset | null; message: ReactNode }) {
  const metric = state.query.metrics[0];
  return (
    <div className={`big-number big-number-empty big-number-size-${state.display.font_size ?? "auto"}`}>
      <div className="big-number-value is-empty" data-testid="big-number-value" aria-label="No data">
        -
      </div>
      <div className="big-number-subtitle">{state.display.subtitle || (metric ? metricLabel(metric, dataset) : "")}</div>
      {message}
    </div>
  );
}

/** "▲ +12.3% vs previous period" (arrow and sign, so it isn't color alone). */
function Comparison({ value, previous, format }: { value: unknown; previous: ChartDataResult; format(v: unknown): string }) {
  const before = previous.rows[0]?.[0];
  const change = changeRatio(value, before);
  const period =
    previous.range_start && previous.range_end
      ? `${formatBucket(previous.range_start, "day")} – ${formatBucket(previous.range_end, "day")}`
      : "the previous period";
  if (change === null) {
    return (
      <div className="big-number-change" data-testid="big-number-change" title={`Previous period: ${period}`}>
        No data to compare with ({period})
      </div>
    );
  }
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const pct = `${change > 0 ? "+" : change < 0 ? "−" : "±"}${Math.abs(change * 100).toFixed(1)}%`;
  return (
    <div
      className={`big-number-change is-${direction}`}
      data-testid="big-number-change"
      title={`Previous period (${period}): ${format(before)}`}
    >
      {direction === "up" ? <ArrowUp size={14} aria-hidden /> : direction === "down" ? <ArrowDown size={14} aria-hidden /> : null}
      <strong>{pct}</strong>
      <span className="big-number-change-label">vs previous period ({format(before)})</span>
    </div>
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
function BigValue({ value, format }: { value: unknown; format(v: unknown): string }) {
  const n = toNumber(value);
  if (n === null) return <>{format(value)}</>;
  return <CountUp value={n} format={(x) => format(x)} render={splitDecimals} />;
}

function PieView({
  state,
  result,
  total,
  dataset,
  drawColors,
  showHints,
}: {
  state: ChartState;
  result: ChartDataResult;
  total: ChartDataResult | null;
  dataset: Dataset | null;
  drawColors: Pick<DrawContext, "colors" | "labelColor">;
  showHints: boolean;
}) {
  const { resolved } = useTheme();
  const option = useMemo(
    () =>
      pieOption(state, result, dataset, {
        ...drawColors,
        total,
        centerColor: cssVar("--text"),
        mutedColor: cssVar("--text-muted"),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the center colors follow the theme
    [state, result, dataset, drawColors, total, resolved],
  );
  const slices = result.rows.length;
  const metric = state.query.metrics[0];
  return (
    <>
      <EChart option={option} label={`${state.display.donut ? "Donut" : "Pie"} chart of ${metric ? metricLabel(metric, dataset) : ""}`} />
      {showHints && slices > PIE_MAX_READABLE && (
        <p className="chart-notice" role="note" data-testid="pie-warning">
          <TriangleAlert size={14} aria-hidden />
          <span>
            {slices} slices: a pie is hard to read past {PIE_MAX_READABLE}. Lower “Top slices” to group the rest into “Other”, or use
            a bar chart.
          </span>
        </p>
      )}
    </>
  );
}
