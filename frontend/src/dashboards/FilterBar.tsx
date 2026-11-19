import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Filter, Pencil, Plus, RotateCcw, Save, X } from "lucide-react";
import {
  getColumnValues,
  type AppliedDashboardFilter,
  type ChartTimeRange,
  type DashboardFilterDef,
  type FilterScalar,
  type FilterSelection,
  type RangeKind,
} from "../api.ts";
import { TIME_RANGES } from "../charts/timeRanges.ts";
import { Button } from "../components/ui/button.tsx";
import { errorText } from "../datasets/format.ts";
import {
  allDefault,
  crossText,
  filterLabel,
  isActive,
  KIND_LABELS,
  parentFilters,
  scalarText,
  selectionText,
  type CrossFilter,
  type FilterValues,
} from "./filters.ts";
import type { DatasetCache } from "./tileData.ts";

type Props = {
  defs: DashboardFilterDef[];
  values: FilterValues;
  editing: boolean;
  datasets: DatasetCache;
  onChange(id: string, selection: FilterSelection): void;
  onReset(): void;
  onSaveDefaults(): void;
  onAdd(): void;
  onEdit(def: DashboardFilterDef): void;
  onRemove(def: DashboardFilterDef): void;
  /** Cross filters (clicks on chart elements), shown as removable chips. */
  cross?: CrossFilter[];
  /** The name of the chart on a tile. */
  crossSource?(tile: string): string | null;
  onCrossRemove?(tile: string): void;
};

/** The dashboard's filter bar: one control per filter (view mode), or the filters to
 * configure (edit mode). Values change the URL at once; tiles reload debounced. */
export default function FilterBar({
  defs,
  values,
  editing,
  datasets,
  onChange,
  onReset,
  onSaveDefaults,
  onAdd,
  onEdit,
  onRemove,
  cross = [],
  crossSource,
  onCrossRemove,
}: Props) {
  if (!editing && defs.length === 0 && cross.length === 0) return null;
  const changed = !allDefault(defs, values);
  return (
    <section className="dfilter-bar" aria-label="Dashboard filters">
      <span className="dfilter-bar-title eyebrow">
        <Filter size={13} aria-hidden /> Filters
      </span>
      {editing
        ? defs.map((def) => (
            <span key={def.id} className="dfilter dfilter-config">
              <span className="dfilter-label">{filterLabel(def)}</span>
              <span className="dfilter-kind">{KIND_LABELS[def.kind]}</span>
              <button type="button" className="dfilter-icon" onClick={() => onEdit(def)} aria-label={`Edit filter ${filterLabel(def)}`} title="Edit">
                <Pencil size={13} aria-hidden />
              </button>
              <button type="button" className="dfilter-icon" onClick={() => onRemove(def)} aria-label={`Remove filter ${filterLabel(def)}`} title="Remove">
                <X size={14} aria-hidden />
              </button>
            </span>
          ))
        : defs.map((def) => (
            <FilterControl key={def.id} def={def} defs={defs} values={values} datasets={datasets} onChange={(sel) => onChange(def.id, sel)} />
          ))}
      {!editing &&
        cross.map((f) => {
          const source = crossSource?.(f.tile);
          const text = f.conditions.map(crossText).join(" · ");
          return (
            <span key={f.tile} className="dfilter dfilter-cross pop-in" data-testid="cross-chip" title={source ? `From “${source}”: click it again to remove` : undefined}>
              <span className="dfilter-label">{source ?? "Chart"}</span>
              <span className="dfilter-value">{text}</span>
              {onCrossRemove && (
                <button type="button" className="dfilter-icon" onClick={() => onCrossRemove(f.tile)} aria-label={`Remove cross filter ${text}`}>
                  <X size={14} aria-hidden />
                </button>
              )}
            </span>
          );
        })}
      {editing ? (
        <Button variant="ghost" onClick={onAdd}>
          <Plus size={15} aria-hidden /> Add filter
        </Button>
      ) : (
        (changed || cross.length > 0) && (
          <span className="dfilter-actions">
            <Button variant="ghost" onClick={onReset} title="Back to the saved default values">
              <RotateCcw size={14} aria-hidden /> Reset
            </Button>
            {changed && (
              <Button variant="ghost" onClick={onSaveDefaults} title="Open the dashboard with these values from now on">
                <Save size={14} aria-hidden /> Save as default
              </Button>
            )}
          </span>
        )
      )}
    </section>
  );
}

type ControlProps = {
  def: DashboardFilterDef;
  defs: DashboardFilterDef[];
  values: FilterValues;
  datasets: DatasetCache;
  onChange(sel: FilterSelection): void;
};

function FilterControl(props: ControlProps) {
  const { def, values, onChange } = props;
  const value = values[def.id];
  if (def.kind === "time") return <TimeControl def={def} value={value} onChange={onChange} />;
  if (def.kind === "range") return <RangeControl def={def} value={value} onChange={onChange} />;
  return <ValuesControl {...props} />;
}

/** A pill that opens a small panel (Escape or a click outside closes it). */
function Popover({ def, active, summary, children }: { def: DashboardFilterDef; active: boolean; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <span
      className="dfilter-wrap"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          ref.current?.querySelector("button")?.focus();
        }
      }}
    >
      <button
        type="button"
        className={`dfilter${active ? " active" : ""}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dfilter-label">{filterLabel(def)}</span>
        <span className="dfilter-value">{summary}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="dfilter-pop" id={panelId} role="dialog" aria-label={filterLabel(def)}>
          {children}
        </div>
      )}
    </span>
  );
}

function TimeControl({ def, value, onChange }: { def: DashboardFilterDef; value: FilterSelection | undefined; onChange(sel: FilterSelection): void }) {
  const range: ChartTimeRange = value?.time_range ?? { kind: "none" };
  const set = (r: ChartTimeRange) => onChange(r.kind === "none" ? {} : { time_range: r });
  return (
    <Popover def={def} active={isActive("time", value)} summary={selectionText(def, value)}>
      <label className="control">
        <span>Time range</span>
        <select
          aria-label={`${filterLabel(def)}: time range`}
          value={range.kind}
          onChange={(e) => {
            const kind = e.target.value as RangeKind;
            set(kind === "custom" ? { kind, start: range.start ?? null, end: range.end ?? null } : { kind });
          }}
        >
          {TIME_RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.value === "none" ? "All time" : r.label}
            </option>
          ))}
        </select>
      </label>
      {range.kind === "custom" && (
        <div className="inline-controls">
          <input type="date" aria-label="Start date" value={range.start ?? ""} onChange={(e) => set({ ...range, start: e.target.value || null })} />
          <span className="muted">to</span>
          <input type="date" aria-label="End date" value={range.end ?? ""} onChange={(e) => set({ ...range, end: e.target.value || null })} />
        </div>
      )}
      <p className="small muted dfilter-hint">Applies to each chart's own time column.</p>
    </Popover>
  );
}

function parseNumber(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function RangeControl({ def, value, onChange }: { def: DashboardFilterDef; value: FilterSelection | undefined; onChange(sel: FilterSelection): void }) {
  // Typed text is kept while it's being edited ("-", "1.").
  const [minText, setMinText] = useState(value?.min != null ? String(value.min) : "");
  const [maxText, setMaxText] = useState(value?.max != null ? String(value.max) : "");
  useEffect(() => {
    setMinText((t) => (parseNumber(t) === (value?.min ?? null) ? t : value?.min != null ? String(value.min) : ""));
    setMaxText((t) => (parseNumber(t) === (value?.max ?? null) ? t : value?.max != null ? String(value.max) : ""));
  }, [value?.min, value?.max]);
  const update = (min: string, max: string) => {
    const sel: FilterSelection = {};
    const lo = parseNumber(min);
    const hi = parseNumber(max);
    if (lo !== null) sel.min = lo;
    if (hi !== null) sel.max = hi;
    onChange(sel);
  };
  const swapped = value?.min != null && value.max != null && value.min > value.max;
  return (
    <Popover def={def} active={isActive("range", value)} summary={selectionText(def, value)}>
      <div className="inline-controls">
        <input
          type="number"
          inputMode="decimal"
          aria-label={`${filterLabel(def)}: minimum`}
          placeholder="Min"
          value={minText}
          onChange={(e) => {
            setMinText(e.target.value);
            update(e.target.value, maxText);
          }}
        />
        <span className="muted">to</span>
        <input
          type="number"
          inputMode="decimal"
          aria-label={`${filterLabel(def)}: maximum`}
          placeholder="Max"
          value={maxText}
          onChange={(e) => {
            setMaxText(e.target.value);
            update(minText, e.target.value);
          }}
        />
      </div>
      {swapped && <p className="small dfilter-hint">The minimum is above the maximum: no row can match.</p>}
      <p className="small muted dfilter-hint">Both ends included; empty values are left out.</p>
      {isActive("range", value) && (
        <Button variant="ghost" onClick={() => onChange({})}>
          Clear
        </Button>
      )}
    </Popover>
  );
}

function ValuesControl({ def, defs, values, datasets, onChange }: ControlProps) {
  const value = values[def.id];
  const parents = parentFilters(def, defs, values);
  const [labels, setLabels] = useState<Record<string, string> | null>(null);
  const selected = value?.values ?? [];
  useEffect(() => {
    if (def.dataset_id === null) return;
    let cancelled = false;
    datasets
      .get(def.dataset_id)
      .then((d) => !cancelled && setLabels(d.columns.find((c) => c.name === def.column)?.value_labels ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [datasets, def.dataset_id, def.column]);
  return (
    <Popover def={def} active={selected.length > 0} summary={selectionText(def, value, labels)}>
      <ValuesPicker def={def} parents={parents} parentNames={parents.map((p) => filterLabel(defs.find((d) => d.id === p.id)!))} selected={selected} labels={labels} onChange={(vals) => onChange(vals.length ? { values: vals } : {})} />
    </Popover>
  );
}

const keyOf = (v: FilterScalar) => JSON.stringify(v);

/** Search + checkboxes over the column's distinct values (loaded when the panel opens). */
function ValuesPicker({
  def,
  parents,
  parentNames,
  selected,
  labels,
  onChange,
}: {
  def: DashboardFilterDef;
  /** The current values of the filters it depends on (they limit the choices). */
  parents: AppliedDashboardFilter[];
  parentNames: string[];
  selected: FilterScalar[];
  labels: Record<string, string> | null;
  onChange(values: FilterScalar[]): void;
}) {
  const parentsKey = JSON.stringify(parents);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FilterScalar[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search in the browser; ask the database only when the list was cut at 1000 values.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(truncated ? search : ""), 300);
    return () => clearTimeout(timer);
  }, [search, truncated]);

  useEffect(() => {
    if (def.dataset_id === null || !def.column) return;
    const controller = new AbortController();
    getColumnValues(def.dataset_id, def.column, query, controller.signal, JSON.parse(parentsKey) as AppliedDashboardFilter[]).then(
      (res) => {
        setOptions(res.values);
        if (!query) setTruncated(res.truncated);
        setError(null);
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err));
      },
    );
    return () => controller.abort();
  }, [def.dataset_id, def.column, query, parentsKey]);

  const chosen = new Set(selected.map(keyOf));
  const needle = search.trim().toLowerCase();
  const shown = (options ?? []).filter((v) => !needle || scalarText(v, labels).toLowerCase().includes(needle));
  // Selected values stay listed (first) even when the search or the list doesn't have them.
  const extra = selected.filter((v) => !shown.some((o) => keyOf(o) === keyOf(v)));
  const toggle = (v: FilterScalar) =>
    onChange(chosen.has(keyOf(v)) ? selected.filter((s) => keyOf(s) !== keyOf(v)) : [...selected, v]);

  return (
    <div className="dfilter-values">
      <input
        type="search"
        aria-label={`Search ${filterLabel(def)} values`}
        placeholder="Search values"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />
      {error ? (
        <p className="alert alert-error small">
          <strong>Error: </strong>
          {error}
        </p>
      ) : options === null ? (
        <span className="skeleton dfilter-skeleton" role="status" aria-label="Loading values" />
      ) : (
        <ul className="dfilter-options" aria-label={`${filterLabel(def)} values`}>
          {[...extra, ...shown].map((v) => (
            <li key={keyOf(v)}>
              <label>
                <input type="checkbox" checked={chosen.has(keyOf(v))} onChange={() => toggle(v)} />
                <span className={v === null ? "muted" : undefined}>{scalarText(v, labels)}</span>
              </label>
            </li>
          ))}
          {shown.length + extra.length === 0 && <li className="muted small">No matching values</li>}
        </ul>
      )}
      {truncated && <p className="small muted dfilter-hint">Showing the first 1000 values: search to find others.</p>}
      {parentNames.length > 0 && <p className="small muted dfilter-hint">Only values that match {parentNames.join(" and ")}.</p>}
      <div className="dfilter-pop-actions">
        <span className="small muted">{selected.length ? `${selected.length} selected` : "All values"}</span>
        {selected.length > 0 && (
          <Button variant="ghost" onClick={() => onChange([])}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
