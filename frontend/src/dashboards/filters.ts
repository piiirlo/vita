/** Dashboard filters (Part 15), pure: current values in the URL, which charts a filter
 * targets, what each tile sends with its chart-data requests, and labels. */
import type {
  AppliedDashboardFilter,
  ChartTimeRange,
  Dataset,
  DashboardFilterDef,
  DashboardFilterKind,
  FilterScalar,
  FilterSelection,
} from "../api.ts";
import { sameSelection as sameCross, type CrossCondition, type CrossSelection } from "../charts/crossSelect.ts";
import { TIME_RANGES } from "../charts/timeRanges.ts";

/** Current selection of every filter, by filter id. */
export type FilterValues = Record<string, FilterSelection>;

/** URL parameter of a filter's current value: ?f_<id>=<json>. Absent = the saved default. */
export const PARAM_PREFIX = "f_";
export const FILTER_DEBOUNCE_MS = 350;

export const KIND_LABELS: Record<DashboardFilterKind, string> = {
  time: "Time range",
  values: "Values",
  range: "Number range",
};

export function newFilterId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- selections ----------

/** Only the field of the filter's kind, without empty parts. */
export function cleanSelection(kind: DashboardFilterKind, sel: FilterSelection | null | undefined): FilterSelection {
  if (!sel) return {};
  switch (kind) {
    case "time":
      return sel.time_range && sel.time_range.kind !== "none" ? { time_range: sel.time_range } : {};
    case "values":
      return sel.values?.length ? { values: sel.values } : {};
    case "range": {
      const out: FilterSelection = {};
      if (typeof sel.min === "number" && Number.isFinite(sel.min)) out.min = sel.min;
      if (typeof sel.max === "number" && Number.isFinite(sel.max)) out.max = sel.max;
      return out;
    }
  }
}

/** Whether a selection filters anything. A custom range needs a start or an end. */
export function isActive(kind: DashboardFilterKind, sel: FilterSelection | undefined): boolean {
  const clean = cleanSelection(kind, sel);
  if (kind === "time") {
    const range = clean.time_range;
    return !!range && (range.kind !== "custom" || !!range.start || !!range.end);
  }
  return Object.keys(clean).length > 0;
}

const sameSelection = (kind: DashboardFilterKind, a: FilterSelection | undefined, b: FilterSelection | undefined) =>
  JSON.stringify(cleanSelection(kind, a)) === JSON.stringify(cleanSelection(kind, b));

// ---------- URL ----------

function parseSelection(kind: DashboardFilterKind, raw: string): FilterSelection | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const sel = parsed as FilterSelection;
    if (kind === "values" && sel.values !== undefined && !Array.isArray(sel.values)) return null;
    if (kind === "time" && sel.time_range && typeof sel.time_range.kind !== "string") return null;
    return cleanSelection(kind, sel);
  } catch {
    return null;
  }
}

/** Current values: the URL's, else each filter's saved default. Broken parameters are ignored. */
export function readFilterValues(search: URLSearchParams, defs: DashboardFilterDef[]): FilterValues {
  const values: FilterValues = {};
  for (const def of defs) {
    const raw = search.get(PARAM_PREFIX + def.id);
    const fromUrl = raw === null ? null : parseSelection(def.kind, raw);
    values[def.id] = fromUrl ?? cleanSelection(def.kind, def.default);
  }
  return values;
}

/** The URL with one f_<id> per value that differs from the saved default (others untouched). */
export function writeFilterValues(search: URLSearchParams, defs: DashboardFilterDef[], values: FilterValues): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const key of [...next.keys()]) if (key.startsWith(PARAM_PREFIX)) next.delete(key);
  for (const def of defs) {
    const value = values[def.id];
    if (!sameSelection(def.kind, value, def.default)) {
      next.set(PARAM_PREFIX + def.id, JSON.stringify(cleanSelection(def.kind, value)));
    }
  }
  return next;
}

/** Whether every value is its filter's saved default ("Reset" / "Save as default" hidden). */
export function allDefault(defs: DashboardFilterDef[], values: FilterValues): boolean {
  return defs.every((def) => sameSelection(def.kind, values[def.id], def.default));
}

/** The filters with the current values as their defaults ("Save as default"). */
export function withDefaults(defs: DashboardFilterDef[], values: FilterValues): DashboardFilterDef[] {
  return defs.map((def) => ({ ...def, default: cleanSelection(def.kind, values[def.id]) }));
}

// ---------- targeting ----------

const usable = (dataset: Dataset, name: string | null) =>
  dataset.columns.find((c) => c.name === name && !c.is_missing && !c.is_hidden);

/** Whether the dataset has what the filter needs (the backend checks the same and has the
 * last word: a chart-data response lists the filters it applied). */
export function datasetFits(def: DashboardFilterDef, dataset: Dataset): boolean {
  if (def.kind === "time") {
    return dataset.columns.some((c) => c.is_temporal && !c.is_missing && !c.is_hidden);
  }
  const col = usable(dataset, def.column);
  if (!col) return false;
  return def.kind === "range" ? col.effective_type === "number" : col.effective_type !== "other";
}

/** Whether a filter is meant for a chart: its explicit chart list, else every chart whose
 * dataset has the column (time: a time column). */
export function targetsChart(def: DashboardFilterDef, chartId: number, dataset: Dataset): boolean {
  if (def.targets) return def.targets.includes(chartId);
  return datasetFits(def, dataset);
}

/** What a tile sends with its chart-data requests: the active filters that target it. */
export function filtersForChart(
  defs: DashboardFilterDef[],
  values: FilterValues,
  chartId: number,
  dataset: Dataset,
): AppliedDashboardFilter[] {
  return defs
    .filter((def) => isActive(def.kind, values[def.id]) && targetsChart(def, chartId, dataset))
    .map((def) => ({ id: def.id, kind: def.kind, column: def.column, ...cleanSelection(def.kind, values[def.id]) }));
}

/** A tile's filter state: the active filters that changed its data, and those that didn't. */
export function tileFilterStatus(
  defs: DashboardFilterDef[],
  values: FilterValues,
  applied: string[] | undefined,
): { filteredBy: DashboardFilterDef[]; notFilteredBy: DashboardFilterDef[] } {
  const active = defs.filter((def) => isActive(def.kind, values[def.id]));
  const done = new Set(applied ?? []);
  return {
    filteredBy: active.filter((def) => done.has(def.id)),
    notFilteredBy: active.filter((def) => !done.has(def.id)),
  };
}

// ---------- labels ----------

export function filterLabel(def: DashboardFilterDef): string {
  return def.label.trim() || (def.kind === "time" ? "Time range" : (def.column ?? KIND_LABELS[def.kind]));
}

export function scalarText(value: FilterScalar, labels?: Record<string, string> | null): string {
  if (value === null) return "(empty)";
  const text = String(value);
  return labels?.[text] ?? text;
}

function rangeText(range: ChartTimeRange): string {
  if (range.kind !== "custom") return TIME_RANGES.find((r) => r.value === range.kind)?.label ?? range.kind;
  if (range.start && range.end) return `${range.start} – ${range.end}`;
  if (range.start) return `From ${range.start}`;
  if (range.end) return `Until ${range.end}`;
  return "Custom";
}

/** Short text of the current selection, e.g. "Last 30 days", "shipped, returned", "≥ 2". */
export function selectionText(def: DashboardFilterDef, sel: FilterSelection | undefined, labels?: Record<string, string> | null): string {
  if (!isActive(def.kind, sel) || !sel) return "All";
  if (def.kind === "time") return rangeText(sel.time_range as ChartTimeRange);
  if (def.kind === "values") {
    const values = sel.values ?? [];
    return values.length <= 2 ? values.map((v) => scalarText(v, labels)).join(", ") : `${values.length} selected`;
  }
  const { min, max } = sel;
  if (min != null && max != null) return `${min} – ${max}`;
  return min != null ? `≥ ${min}` : `≤ ${max}`;
}

// ---------- dependent filters ----------

/** The current values of the filters a values filter depends on (City: the chosen Country),
 * as sent to the values endpoint. Inactive parents are left out. */
export function parentFilters(def: DashboardFilterDef, defs: DashboardFilterDef[], values: FilterValues): AppliedDashboardFilter[] {
  return (def.depends_on ?? []).flatMap((id) => {
    const parent = defs.find((d) => d.id === id);
    if (!parent || !isActive(parent.kind, values[id])) return [];
    return [{ id, kind: parent.kind, column: parent.column, ...cleanSelection(parent.kind, values[id]) }];
  });
}


// ---------- cross-filtering ----------

/** A click on a chart element (tile `tile`) filters the other charts on its values. */
export type CrossFilter = { tile: string; conditions: CrossSelection };

export const CROSS_PARAM = "xf";

function validCondition(c: unknown): c is CrossCondition {
  const cond = c as CrossCondition;
  return !!cond && typeof cond.column === "string" && Array.isArray(cond.values);
}

/** The cross filters in the URL (?xf=<json>); broken ones are ignored. */
export function readCrossFilters(search: URLSearchParams): CrossFilter[] {
  const raw = search.get(CROSS_PARAM);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is CrossFilter =>
        !!f && typeof (f as CrossFilter).tile === "string" && Array.isArray((f as CrossFilter).conditions) && (f as CrossFilter).conditions.every(validCondition),
    );
  } catch {
    return [];
  }
}

export function writeCrossFilters(search: URLSearchParams, cross: CrossFilter[]): URLSearchParams {
  const next = new URLSearchParams(search);
  if (cross.length) next.set(CROSS_PARAM, JSON.stringify(cross));
  else next.delete(CROSS_PARAM);
  return next;
}

/** A click on a tile: selects it (replacing that tile's earlier selection), or clears it when
 * the same element is clicked again. */
export function toggleCross(cross: CrossFilter[], tile: string, selection: CrossSelection): CrossFilter[] {
  const current = cross.find((f) => f.tile === tile);
  const others = cross.filter((f) => f.tile !== tile);
  return current && sameCross(current.conditions, selection) ? others : [...others, { tile, conditions: selection }];
}

export function crossText(condition: CrossCondition): string {
  const values = condition.values.map((v) => scalarText(v));
  return `${condition.column}: ${values.length <= 2 ? values.join(", ") : `${values.length} values`}`;
}

/** Cross filters as filter definitions + values for a tile: every tile's selection except its
 * own, one values filter per condition (targeted by column, like the filter bar's). */
export function crossFiltersFor(cross: CrossFilter[], tile: string | null): { defs: DashboardFilterDef[]; values: FilterValues } {
  const defs: DashboardFilterDef[] = [];
  const values: FilterValues = {};
  for (const f of cross) {
    if (f.tile === tile) continue;
    f.conditions.forEach((c, i) => {
      const id = `x_${f.tile}_${i}`;
      defs.push({ id, kind: "values", label: crossText(c), column: c.column, dataset_id: null, targets: null, default: {}, depends_on: [] });
      values[id] = { values: c.values };
    });
  }
  return { defs, values };
}
