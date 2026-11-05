import { useState } from "react";
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
  VIZ_TYPES,
  columnLabel,
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
        <div className="control">
          <span>Chart type</span>
          <div className="viz-picker" role="radiogroup" aria-label="Chart type">
            {VIZ_TYPES.map((v) => (
              <button
                key={v.value}
                role="radio"
                aria-checked={vizType === v.value}
                className={vizType === v.value ? "active" : ""}
                onClick={() => onVizType(v.value)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
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
          <label className="control">
            <span>Subtitle</span>
            <input
              value={display.subtitle ?? ""}
              placeholder={query.metrics[0] ? metricLabel(query.metrics[0], dataset) : ""}
              onChange={(e) => onDisplay({ subtitle: e.target.value })}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(display.show_trend)}
              disabled={temporalColumns(dataset).length === 0}
              onChange={(e) => {
                onDisplay({ show_trend: e.target.checked });
                if (e.target.checked && !grain) onQuery({ time: timeWith(query, dataset, { grain: "month" }) });
              }}
            />
            Show trend line
          </label>
        </section>
      )}

      {vizType === "bar" && (
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
          <SeriesSelect query={query} dataset={dataset} columns={nonTimeDims} onQuery={onQuery} />
          <MetricList title="Metrics" dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <div className="checkbox-row">
            <label className="checkbox">
              <input type="checkbox" checked={Boolean(display.stacked)} onChange={(e) => onDisplay({ stacked: e.target.checked })} />
              Stacked
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={Boolean(display.horizontal)}
                onChange={(e) => onDisplay({ horizontal: e.target.checked })}
              />
              Horizontal
            </label>
          </div>
          {!grain && (
            <label className="control">
              <span>Sort bars</span>
              <select value={display.sort ?? "value"} onChange={(e) => onDisplay({ sort: e.target.value as "value" | "label" })}>
                <option value="value">By value (largest first)</option>
                <option value="label">By label</option>
              </select>
            </label>
          )}
        </section>
      )}

      {vizType === "line" && (
        <section>
          <SeriesSelect query={query} dataset={dataset} columns={nonTimeDims} onQuery={onQuery} />
          <MetricList title="Metrics" dataset={dataset} metrics={query.metrics} onChange={(metrics) => onQuery({ metrics })} />
          <label className="checkbox">
            <input type="checkbox" checked={Boolean(display.show_points)} onChange={(e) => onDisplay({ show_points: e.target.checked })} />
            Show points
          </label>
        </section>
      )}

      <TimeSection state={state} dataset={dataset} onQuery={onQuery} />

      <section>
        <FilterList dataset={dataset} filters={query.filters} onChange={(filters) => onQuery({ filters })} />
      </section>

      <section>
        {vizType !== "big_number" && (
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
          {vizType !== "big_number" && (
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
      </section>
    </div>
  );
}

// ---------- helpers ----------

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
  onChange,
}: {
  title: string;
  columns: DatasetColumn[];
  selected: string[];
  dataset: Dataset;
  onChange(names: string[]): void;
}) {
  const available = columns.filter((c) => !selected.includes(c.name));
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
        <select aria-label={`Add to ${title}`} value="" onChange={(e) => e.target.value && onChange([...selected, e.target.value])}>
          <option value="">+ Add column…</option>
          {available.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label || c.name}
            </option>
          ))}
        </select>
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
  const grainRequired = vizType === "line" || (vizType === "big_number" && display.show_trend);
  const grainShown = !raw && !(vizType === "big_number" && !display.show_trend) && !(vizType === "bar" && !time.grain);

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
