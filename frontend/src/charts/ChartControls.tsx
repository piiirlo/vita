import { useState } from "react";
import ChartTypePicker from "./ChartTypePicker.tsx";
import type {
  Aggregate,
  ChartFilter,
  ChartQuery,
  Dataset,
  DatasetColumn,
  DatasetListItem,
  FilterOperator,
  FilterScalar,
  GenericType,
  Grain,
  MetricRef,
  RangeKind,
  VizType,
} from "../api.ts";
import {
  GRAINS,
  PIVOT_MAX_COLUMN_DIMENSIONS,
  PIVOT_MAX_ROW_DIMENSIONS,
  adaptToViz,
  columnLabel,
  missingFor,
  switchReport,
  type SwitchReport,
  groupableColumns,
  metricLabel,
  metricName,
  outputLabel,
  outputNames,
  temporalColumns,
  usableColumns,
  type ChartState,
  type DisplayOptions,
} from "./model.ts";
import { CACHE_TTLS, DEFAULT_CACHE_TTL } from "./load.ts";

type Props = {
  state: ChartState;
  dataset: Dataset;
  datasets: DatasetListItem[];
  onDataset(id: number): void;
  onVizType(viz: VizType): void;
  onQuery(patch: Partial<ChartQuery>): void;
  onDisplay(patch: Partial<DisplayOptions>): void;
};

const RANGES: { value: RangeKind; label: string }[] = [
  { value: "none", label: "No filter" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom…" },
];

const AGGREGATES: { value: Aggregate; label: string; types: GenericType[] | null }[] = [
  { value: "SUM", label: "Sum", types: ["number"] },
  { value: "AVG", label: "Average", types: ["number"] },
  { value: "MIN", label: "Min", types: ["number", "date", "datetime", "string"] },
  { value: "MAX", label: "Max", types: ["number", "date", "datetime", "string"] },
  { value: "COUNT", label: "Count", types: null },
  { value: "COUNT_DISTINCT", label: "Count distinct", types: null },
];

// Same rules as the backend (app/charts/filters.py).
const ALWAYS: FilterOperator[] = ["=", "!=", "IN", "NOT IN", "IS NULL", "IS NOT NULL"];
const COMPARE: FilterOperator[] = [">", ">=", "<", "<=", "BETWEEN"];
function operatorsFor(type: GenericType): FilterOperator[] {
  if (type === "number" || type === "date" || type === "datetime") return [...ALWAYS, ...COMPARE];
  if (type === "string") return [...ALWAYS, "LIKE"];
  return ["=", "!=", "IS NULL", "IS NOT NULL"];
}
const OPERATOR_LABELS: Partial<Record<FilterOperator, string>> = {
  "!=": "≠",
  LIKE: "contains",
  "IN": "in",
  "NOT IN": "not in",
  BETWEEN: "between",
  "IS NULL": "is empty",
  "IS NOT NULL": "is not empty",
};

export default function ChartControls({ state, dataset, datasets, onDataset, onVizType, onQuery, onDisplay }: Props) {
  const { vizType, query, display } = state;
  const raw = vizType === "table" && display.mode === "raw";
  const grain = query.time?.grain ?? null;
  const dims = groupableColumns(dataset);
  const nonTimeDims = dims.filter((c) => c.name !== (grain ? query.time?.column : null));
  const categories = dims.filter((c) => !c.is_temporal);
  // What carried over the last chart type switch (kept / dropped); the to-do list is live.
  const [report, setReport] = useState<{ viz: VizType; report: SwitchReport } | null>(null);
  const todo = missingFor(state, dataset);

  return (
    <div className="chart-controls">
      <section>
        <label className="control">
          <span>Dataset</span>
          <select aria-label="Dataset" value={dataset.id} onChange={(e) => onDataset(Number(e.target.value))}>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <ChartTypePicker
          value={vizType}
          onChange={(viz) => {
            setReport({ viz, report: switchReport(state, adaptToViz(state, viz, dataset), dataset) });
            onVizType(viz);
          }}
        />
        <SwitchNote report={report?.viz === vizType ? report.report : null} todo={todo} onDismiss={() => setReport(null)} />
      </section>

      {vizType === "table" && (
        <section>
          <div className="segmented" role="radiogroup" aria-label="Table mode">
            {(["aggregate", "raw"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={(display.mode ?? "aggregate") === m}
                className={(display.mode ?? "aggregate") === m ? "active" : ""}
                onClick={() => onDisplay({ mode: m })}
              >
                {m === "aggregate" ? "Grouped" : "Raw records"}
              </button>
            ))}
          </div>
          {raw ? (
            <ColumnList
              title="Columns"
              columns={usableColumns(dataset)}
              selected={query.columns}
              dataset={dataset}
              onChange={(columns) => onQuery({ columns })}
            />
          ) : (
            <>
              <ColumnList
                title="Group by"
                columns={nonTimeDims}
                selected={query.dimensions}
                dataset={dataset}
                onChange={(dimensions) => onQuery({ dimensions })}
              />
              <MetricList title="Metrics" dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
            </>
          )}
        </section>
      )}

      {vizType === "big_number" && (
        <section>
          <MetricList title="Metric" single dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <p className="control-hint">Subtitle, colors, trend line and comparison are in Customize.</p>
        </section>
      )}

      {(vizType === "bar" || vizType === "combo") && (
        <section>
          <label className="control">
            <span>X axis</span>
            <select
              aria-label="X axis"
              value={grain ? "__time__" : (query.dimensions[0] ?? "")}
              onChange={(e) => {
                if (e.target.value === "__time__") {
                  onQuery({ dimensions: [], time: timeWith(query, dataset, { grain: grain ?? "month" }) });
                } else {
                  onQuery({ dimensions: [e.target.value], time: timeWith(query, dataset, { grain: null }) });
                }
              }}
            >
              {!grain && query.dimensions.length === 0 && <option value="">Pick…</option>}
              {temporalColumns(dataset).length > 0 && <option value="__time__">Time (by grain)</option>}
              {dims
                .filter((c) => !c.is_temporal)
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label || c.name}
                  </option>
                ))}
            </select>
          </label>
          {vizType === "bar" && <SeriesSelect query={query} dataset={dataset} columns={nonTimeDims} onQuery={onQuery} />}
          <MetricList title="Metrics" dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          {vizType === "combo" && <p className="control-hint">Bars or line and left or right axis per metric are in Customize.</p>}
        </section>
      )}

      {vizType === "pie" && (
        <section>
          <label className="control">
            <span>Slices</span>
            <select
              aria-label="Slices"
              value={query.dimensions[0] ?? ""}
              onChange={(e) => onQuery({ dimensions: e.target.value ? [e.target.value] : [] })}
            >
              {query.dimensions.length === 0 && <option value="">Pick…</option>}
              {dims
                .filter((c) => !c.is_temporal)
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label || c.name}
                  </option>
                ))}
            </select>
          </label>
          <MetricList title="Metric" single dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <label className="control">
            <span>Top slices</span>
            <NumberInput
              value={query.series_limit ?? 0}
              min={0}
              max={100}
              title="Keep the N biggest slices and group the rest into Other (0 = every slice)"
              onChange={(n) => onQuery({ series_limit: n > 0 ? n : null })}
            />
          </label>
          <p className="control-hint">The rest is grouped into “Other”. Donut, sorting and labels are in Customize.</p>
        </section>
      )}

      {(vizType === "line" || vizType === "area") && (
        <section>
          <SeriesSelect query={query} dataset={dataset} columns={nonTimeDims} onQuery={onQuery} />
          <MetricList title="Metrics" dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
        </section>
      )}

      {vizType === "treemap" && (
        <section>
          <DimensionSelect label="Boxes" value={query.dimensions[0] ?? ""} columns={categories} dataset={dataset}
            onChange={(name) => onQuery({ dimensions: name ? [name, ...query.dimensions.slice(1).filter((d) => d !== name)] : [] })} />
          <DimensionSelect label="Inside each box" optional value={query.dimensions[1] ?? ""} dataset={dataset}
            columns={categories.filter((c) => c.name !== query.dimensions[0])}
            onChange={(name) => onQuery({ dimensions: [query.dimensions[0] ?? "", ...(name ? [name] : [])].filter(Boolean) })} />
          <MetricList title="Metric" single dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <label className="control">
            <span>Top boxes</span>
            <NumberInput
              value={query.series_limit ?? 0}
              min={0}
              max={100}
              title="Keep the N biggest outer boxes and group the rest into Other (0 = every box)"
              onChange={(n) => onQuery({ series_limit: n > 0 ? n : null })}
            />
          </label>
          <p className="control-hint">The rest is grouped into “Other”. Colors, names and labels are in Customize.</p>
        </section>
      )}

      {vizType === "funnel" && (
        <section>
          <DimensionSelect label="Steps" value={query.dimensions[0] ?? ""} columns={categories} dataset={dataset}
            onChange={(name) => onQuery({ dimensions: name ? [name] : [] })} />
          <MetricList title="Metric" single dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <p className="control-hint">Largest step first; pick your own step order in Customize.</p>
        </section>
      )}

      {vizType === "gauge" && (
        <section>
          <MetricList title="Metric" single dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <p className="control-hint">Min, max, target and color bands are in Customize.</p>
        </section>
      )}

      {vizType === "pivot_table" && (
        <section>
          <ColumnList
            title="Rows"
            columns={dims.filter((c) => !(query.column_dimensions ?? []).includes(c.name))}
            selected={query.dimensions}
            dataset={dataset}
            max={PIVOT_MAX_ROW_DIMENSIONS}
            fullHint={`A pivot table has at most ${PIVOT_MAX_ROW_DIMENSIONS} row dimensions: remove one, or move it to the columns.`}
            onChange={(dimensions) => onQuery({ dimensions })}
          />
          <ColumnList
            title="Columns"
            columns={dims.filter((c) => !query.dimensions.includes(c.name))}
            selected={query.column_dimensions ?? []}
            dataset={dataset}
            max={PIVOT_MAX_COLUMN_DIMENSIONS}
            fullHint={`A pivot table has at most ${PIVOT_MAX_COLUMN_DIMENSIONS} column dimensions: remove one, or move it to the rows.`}
            onChange={(column_dimensions) => onQuery({ column_dimensions })}
          />
          <MetricList title="Metrics" dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <label className="checkbox">
            <input type="checkbox" checked={Boolean(query.totals)} onChange={(e) => onQuery({ totals: e.target.checked })} />
            Totals and subtotals
          </label>
          <p className="control-hint">Totals are computed by the database, so averages and distinct counts add up correctly. Heat colors are in Customize.</p>
        </section>
      )}

      <TimeSection state={state} dataset={dataset} onQuery={onQuery} />

      <section>
        <FilterList dataset={dataset} filters={query.filters} onChange={(filters) => onQuery({ filters })} />
      </section>

      <section>
        {ORDERABLE.has(vizType) && (
          <label className="control">
            <span>Order by</span>
            <div className="inline-controls">
              <select
                aria-label="Order by"
                value={query.order_by?.by ?? ""}
                onChange={(e) =>
                  onQuery({ order_by: e.target.value ? { by: e.target.value, descending: query.order_by?.descending ?? true } : null })
                }
              >
                <option value="">Default</option>
                {outputNames(query, vizType, display).map((n) => (
                  <option key={n} value={n}>
                    {outputLabel(n, query, dataset)}
                  </option>
                ))}
              </select>
              {query.order_by && (
                <select
                  aria-label="Order direction"
                  value={query.order_by.descending ? "desc" : "asc"}
                  onChange={(e) => onQuery({ order_by: { ...query.order_by!, descending: e.target.value === "desc" } })}
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              )}
            </div>
          </label>
        )}
        <div className="inline-controls">
          {!NO_ROW_LIMIT.has(vizType) && (
            <label className="control">
              <span>Row limit</span>
              <NumberInput value={query.row_limit} min={1} max={10000} onChange={(row_limit) => onQuery({ row_limit })} />
            </label>
          )}
          {query.series && (
            <label className="control">
              <span>Top series</span>
              <NumberInput
                value={query.series_limit ?? 0}
                min={0}
                max={1000}
                title="Keep only the N biggest series by the first metric (0 = all)"
                onChange={(n) => onQuery({ series_limit: n > 0 ? n : null })}
              />
            </label>
          )}
        </div>
        <label className="control">
          <span>Cache results</span>
          <select
            aria-label="Cache results"
            title="Charts reuse a result this long (Update chart and Refresh always query again)"
            value={display.cache_ttl ?? ""}
            onChange={(e) => onDisplay({ cache_ttl: e.target.value === "" ? undefined : Number(e.target.value) })}
          >
            <option value="">Default (10 minutes)</option>
            {CACHE_TTLS.filter((t) => t.value !== DEFAULT_CACHE_TTL).map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </section>
    </div>
  );
}

/** Chart types the user can order (the others have their own order). */
const ORDERABLE = new Set<VizType>(["table", "bar", "line", "area", "combo"]);
/** One number or a fixed number of slices / steps: no row limit to set. */
const NO_ROW_LIMIT = new Set<VizType>(["big_number", "gauge", "pie", "funnel"]);

// ---------- helpers ----------

/** After a chart type switch: what carried over and what didn't; and what still needs setting. */
function SwitchNote({ report, todo, onDismiss }: { report: SwitchReport | null; todo: string[]; onDismiss(): void }) {
  const dropped = report?.dropped ?? [];
  if (dropped.length === 0 && todo.length === 0) return null;
  return (
    <div className="switch-note" role="status">
      {report && dropped.length > 0 && (
        <>
          <p>
            <strong>Kept:</strong> {report.kept.join(", ")}.
          </p>
          <p>
            <strong>Not used:</strong> {dropped.join("; ")}.
          </p>
        </>
      )}
      {todo.length > 0 && (
        <ul className="switch-todo" aria-label="Still to set">
          {todo.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      {report && dropped.length > 0 && (
        <button type="button" className="link-button small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

function DimensionSelect({
  label,
  value,
  columns,
  dataset,
  optional,
  onChange,
}: {
  label: string;
  value: string;
  columns: DatasetColumn[];
  dataset: Dataset;
  optional?: boolean;
  onChange(name: string): void;
}) {
  return (
    <label className="control">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {optional ? <option value="">None</option> : !value && <option value="">Pick…</option>}
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {columnLabel(c.name, dataset)}
          </option>
        ))}
      </select>
    </label>
  );
}

function timeWith(query: ChartQuery, dataset: Dataset, patch: { grain?: Grain | null; column?: string | null }) {
  const column = patch.column ?? query.time?.column ?? dataset.main_time_column ?? temporalColumns(dataset)[0]?.name ?? null;
  return {
    column,
    grain: patch.grain !== undefined ? patch.grain : (query.time?.grain ?? null),
    range: query.time?.range ?? { kind: "none" as RangeKind },
  };
}

function NumberInput({ value, min, max, onChange, title }: { value: number; min: number; max: number; title?: string; onChange(n: number): void }) {
  const [text, setText] = useState(String(value));
  return (
    <input
      type="number"
      min={min}
      max={max}
      title={title}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Math.round(Number(e.target.value));
        if (e.target.value !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
    />
  );
}

function SeriesSelect({ query, dataset, columns, onQuery }: { query: ChartQuery; dataset: Dataset; columns: DatasetColumn[]; onQuery(p: Partial<ChartQuery>): void }) {
  return (
    <label className="control">
      <span>Series (split by)</span>
      <select aria-label="Series" value={query.series ?? ""} onChange={(e) => onQuery({ series: e.target.value || null })}>
        <option value="">None</option>
        {columns
          .filter((c) => !query.dimensions.includes(c.name))
          .map((c) => (
            <option key={c.name} value={c.name}>
              {columnLabel(c.name, dataset)}
            </option>
          ))}
      </select>
    </label>
  );
}

function ColumnList({
  title,
  columns,
  selected,
  dataset,
  max,
  fullHint,
  onChange,
}: {
  title: string;
  columns: DatasetColumn[];
  selected: string[];
  dataset: Dataset;
  /** At most this many (then the add select is disabled and `fullHint` says why). */
  max?: number;
  fullHint?: string;
  onChange(names: string[]): void;
}) {
  const available = columns.filter((c) => !selected.includes(c.name));
  const full = max !== undefined && selected.length >= max;
  const hintId = `full-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="control">
      <span>{title}</span>
      <ul className="chips" aria-label={title}>
        {selected.map((name) => (
          <li key={name} className="chip">
            {columnLabel(name, dataset)}
            <button aria-label={`Remove ${columnLabel(name, dataset)}`} onClick={() => onChange(selected.filter((n) => n !== name))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {available.length > 0 && (
        <select
          aria-label={`Add to ${title}`}
          value=""
          disabled={full}
          aria-describedby={full ? hintId : undefined}
          onChange={(e) => e.target.value && onChange([...selected, e.target.value])}
        >
          <option value="">+ Add column…</option>
          {available.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label || c.name}
            </option>
          ))}
        </select>
      )}
      {full && fullHint && (
        <p id={hintId} className="control-hint" role="note">
          {fullHint}
        </p>
      )}
    </div>
  );
}

function MetricList({
  title,
  dataset,
  metrics,
  single,
  onChange,
}: {
  title: string;
  dataset: Dataset;
  metrics: MetricRef[];
  single?: boolean;
  onChange(metrics: MetricRef[]): void;
}) {
  const [aggregate, setAggregate] = useState<Aggregate>("SUM");
  const [column, setColumn] = useState("");
  const names = metrics.map(metricName);
  const saved = dataset.metrics.filter((m) => !names.includes(m.name));
  const allowed = AGGREGATES.find((a) => a.value === aggregate)?.types ?? null;
  const columns = usableColumns(dataset).filter((c) => !allowed || allowed.includes(c.effective_type));
  const add = (ref: MetricRef) => onChange(single ? [ref] : [...metrics.filter((m) => metricName(m) !== metricName(ref)), ref]);

  return (
    <div className="control">
      <span>{title}</span>
      <ul className="chips" aria-label={title}>
        {metrics.map((m) => (
          <li key={metricName(m)} className="chip chip-metric">
            {metricLabel(m, dataset)}
            {!single && (
              <button aria-label={`Remove ${metricLabel(m, dataset)}`} onClick={() => onChange(metrics.filter((x) => x !== m))}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {saved.length > 0 && (
        <select aria-label={single ? "Pick a saved metric" : "Add a saved metric"} value="" onChange={(e) => e.target.value && add(e.target.value)}>
          <option value="">{single ? "Use a saved metric…" : "+ Add saved metric…"}</option>
          {saved.map((m) => (
            <option key={m.name} value={m.name}>
              {m.label || m.name}
            </option>
          ))}
        </select>
      )}
      <div className="inline-controls adhoc">
        <select aria-label="Aggregate" value={aggregate} onChange={(e) => setAggregate(e.target.value as Aggregate)}>
          {AGGREGATES.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <select aria-label="Metric column" value={column} onChange={(e) => setColumn(e.target.value)}>
          <option value="">column…</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label || c.name}
            </option>
          ))}
        </select>
        <button
          className="small"
          disabled={!column || !columns.some((c) => c.name === column)}
          onClick={() => {
            add({ column, aggregate });
            setColumn("");
          }}
        >
          {single ? "Use" : "Add"}
        </button>
      </div>
    </div>
  );
}

function TimeSection({ state, dataset, onQuery }: { state: ChartState; dataset: Dataset; onQuery(p: Partial<ChartQuery>): void }) {
  const { query, vizType, display } = state;
  const temporal = temporalColumns(dataset);
  if (temporal.length === 0) return null;
  const time = query.time ?? { column: dataset.main_time_column ?? temporal[0]!.name, grain: null, range: { kind: "none" } };
  const set = (patch: Partial<NonNullable<ChartQuery["time"]>>) => onQuery({ time: { ...time, ...patch } });
  const raw = vizType === "table" && display.mode === "raw";
  const grainRequired = vizType === "line" || vizType === "area" || (vizType === "big_number" && display.show_trend);
  const noGrain = ["pie", "treemap", "funnel", "gauge", "pivot_table"].includes(vizType);
  const grainShown =
    !raw &&
    !noGrain &&
    !(vizType === "big_number" && !display.show_trend) &&
    !((vizType === "bar" || vizType === "combo") && !time.grain);

  return (
    <section>
      <label className="control">
        <span>Time column</span>
        <select aria-label="Time column" value={time.column ?? ""} onChange={(e) => set({ column: e.target.value })}>
          {temporal.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label || c.name}
              {c.name === dataset.main_time_column ? " (main)" : ""}
            </option>
          ))}
        </select>
      </label>
      {grainShown && (
        <label className="control">
          <span>Time grain</span>
          <select aria-label="Time grain" value={time.grain ?? ""} onChange={(e) => set({ grain: (e.target.value || null) as Grain | null })}>
            {!grainRequired && <option value="">None</option>}
            {GRAINS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="control">
        <span>Time range</span>
        <select
          aria-label="Time range"
          value={time.range.kind}
          onChange={(e) => {
            const kind = e.target.value as RangeKind;
            set({ range: kind === "custom" ? { kind, start: time.range.start ?? null, end: time.range.end ?? null } : { kind } });
          }}
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {time.range.kind === "custom" && (
        <div className="inline-controls">
          <input
            type="date"
            aria-label="Start date"
            value={time.range.start ?? ""}
            onChange={(e) => set({ range: { ...time.range, start: e.target.value || null } })}
          />
          <span className="muted">to</span>
          <input
            type="date"
            aria-label="End date"
            value={time.range.end ?? ""}
            onChange={(e) => set({ range: { ...time.range, end: e.target.value || null } })}
          />
        </div>
      )}
    </section>
  );
}

function FilterList({ dataset, filters, onChange }: { dataset: Dataset; filters: ChartFilter[]; onChange(f: ChartFilter[]): void }) {
  const columns = usableColumns(dataset);
  return (
    <div className="control">
      <span>Filters</span>
      {filters.map((f, i) => (
        <FilterRow
          key={i}
          filter={f}
          dataset={dataset}
          columns={columns}
          onChange={(next) => onChange(filters.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(filters.filter((_, j) => j !== i))}
        />
      ))}
      {columns.length > 0 && (
        <button
          className="small"
          onClick={() => onChange([...filters, { column: columns[0]!.name, operator: "=", value: "" }])}
        >
          + Add filter
        </button>
      )}
    </div>
  );
}

function listValue(text: string, includeEmpty: boolean): FilterScalar[] {
  const values: FilterScalar[] = text
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return includeEmpty ? [...values, null] : values;
}

function FilterRow({
  filter,
  dataset,
  columns,
  onChange,
  onRemove,
}: {
  filter: ChartFilter;
  dataset: Dataset;
  columns: DatasetColumn[];
  onChange(f: ChartFilter): void;
  onRemove(): void;
}) {
  const col = columns.find((c) => c.name === filter.column);
  const type = col?.effective_type ?? "string";
  const ops = operatorsFor(type);
  const list = Array.isArray(filter.value) ? filter.value : null;
  // Comma-separated text for IN lists, kept locally so typing "a," isn't undone.
  const [listText, setListText] = useState(() => (list ?? []).filter((v) => v !== null).join(", "));
  const includeEmpty = Boolean(list?.includes(null));
  const inputType = type === "number" ? "number" : type === "date" ? "date" : type === "datetime" ? "datetime-local" : "text";

  function setOperator(operator: FilterOperator) {
    let value: ChartFilter["value"] = "";
    if (operator === "IN" || operator === "NOT IN") value = listValue(listText, includeEmpty);
    else if (operator === "BETWEEN") value = ["", ""];
    else if (operator === "IS NULL" || operator === "IS NOT NULL") value = null;
    else if (!Array.isArray(filter.value) && filter.value !== null) value = filter.value;
    onChange({ ...filter, operator, value });
  }

  return (
    <div className="filter-row">
      <div className="inline-controls">
        <select
          aria-label="Filter column"
          value={filter.column}
          onChange={(e) => {
            const next = columns.find((c) => c.name === e.target.value);
            const keepOp = next && operatorsFor(next.effective_type).includes(filter.operator);
            onChange({ column: e.target.value, operator: keepOp ? filter.operator : "=", value: keepOp ? filter.value : "" });
          }}
        >
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {columnLabel(c.name, dataset)}
            </option>
          ))}
        </select>
        <select aria-label="Filter operator" value={filter.operator} onChange={(e) => setOperator(e.target.value as FilterOperator)}>
          {ops.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABELS[op] ?? op}
            </option>
          ))}
        </select>
        <button className="small icon" aria-label="Remove filter" onClick={onRemove}>
          ×
        </button>
      </div>
      {(filter.operator === "IN" || filter.operator === "NOT IN") && (
        <>
          <input
            aria-label="Filter values"
            placeholder="value 1, value 2, …"
            value={listText}
            onChange={(e) => {
              setListText(e.target.value);
              onChange({ ...filter, value: listValue(e.target.value, includeEmpty) });
            }}
          />
          <label className="checkbox small">
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={(e) => onChange({ ...filter, value: listValue(listText, e.target.checked) })}
            />
            (empty)
          </label>
        </>
      )}
      {filter.operator === "BETWEEN" && (
        <div className="inline-controls">
          {[0, 1].map((i) => (
            <input
              key={i}
              type={inputType}
              aria-label={i === 0 ? "From" : "To"}
              value={String((list ?? [])[i] ?? "")}
              onChange={(e) => {
                const next = [...(list ?? ["", ""])];
                next[i] = e.target.value;
                onChange({ ...filter, value: next });
              }}
            />
          ))}
        </div>
      )}
      {!["IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL"].includes(filter.operator) && (
        <input
          aria-label="Filter value"
          type={filter.operator === "LIKE" ? "text" : inputType}
          value={Array.isArray(filter.value) || filter.value === null ? "" : String(filter.value)}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
        />
      )}
    </div>
  );
}
