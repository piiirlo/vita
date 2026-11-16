import { useEffect, useState, type FormEvent } from "react";
import { getChart, listDatasets, type Dataset, type DashboardFilterDef, type DashboardFilterKind } from "../api.ts";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";
import { errorText } from "../datasets/format.ts";
import { datasetFits, filterLabel, KIND_LABELS, newFilterId } from "./filters.ts";
import type { DatasetCache } from "./tileData.ts";

type ChartRef = { id: number; name: string };

type Props = {
  /** The filter to edit; null = a new one. */
  initial: DashboardFilterDef | null;
  /** The dashboard's other filters (a values filter can depend on them). */
  others: DashboardFilterDef[];
  charts: ChartRef[];
  datasets: DatasetCache;
  onSave(def: DashboardFilterDef): void;
  onClose(): void;
};

const KINDS: DashboardFilterKind[] = ["values", "time", "range"];
const KIND_HINTS: Record<DashboardFilterKind, string> = {
  values: "Pick values of a column (with search).",
  time: "A time range for every chart, on each chart's own time column.",
  range: "A minimum and a maximum on a number column.",
};

/** Add or edit a dashboard filter: its kind, column, label and which charts it applies to. */
export default function FilterDialog({ initial, others, charts, datasets, onSave, onClose }: Props) {
  const [kind, setKind] = useState<DashboardFilterKind>(initial?.kind ?? "values");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [datasetId, setDatasetId] = useState<number | null>(initial?.dataset_id ?? null);
  const [column, setColumn] = useState(initial?.column ?? "");
  const [targets, setTargets] = useState<number[] | null>(initial?.targets ?? null);
  const [dependsOn, setDependsOn] = useState<string[]>(initial?.depends_on ?? []);
  // Each chart's dataset (for "has this column" and the dataset choices).
  const [chartDatasets, setChartDatasets] = useState<Record<number, Dataset>>({});
  const [choices, setChoices] = useState<{ id: number; name: string }[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      charts.map(async (c) => {
        const chart = await getChart(c.id);
        return [c.id, await datasets.get(chart.dataset_id)] as const;
      }),
    )
      .then(async (pairs) => {
        if (cancelled) return;
        const byChart = Object.fromEntries(pairs) as Record<number, Dataset>;
        setChartDatasets(byChart);
        const used = new Map(pairs.map(([, d]) => [d.id, d.name]));
        // A dashboard without charts yet: every dataset of the project.
        const list = used.size ? [...used].map(([id, name]) => ({ id, name })) : (await listDatasets()).map((d) => ({ id: d.id, name: d.name }));
        if (cancelled) return;
        setChoices(list);
        setDatasetId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((err: unknown) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [charts, datasets]);

  const [dataset, setDataset] = useState<Dataset | null>(null);
  useEffect(() => {
    if (datasetId === null) return;
    let cancelled = false;
    datasets
      .get(datasetId)
      .then((d) => !cancelled && setDataset(d))
      .catch((err: unknown) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [datasetId, datasets]);

  const columns = (dataset?.columns ?? []).filter(
    (c) => !c.is_hidden && !c.is_missing && (kind === "range" ? c.effective_type === "number" : c.effective_type !== "other"),
  );
  const draft: DashboardFilterDef = {
    id: initial?.id ?? newFilterId(),
    kind,
    label: label.trim(),
    column: kind === "time" ? null : column || null,
    dataset_id: kind === "values" ? datasetId : null,
    targets,
    default: initial?.kind === kind ? initial.default : {},
    depends_on: kind === "values" ? dependsOn.filter((id) => others.some((o) => o.id === id)) : [],
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (kind !== "time" && !columns.some((c) => c.name === column)) {
      setProblem("Pick a column.");
      return;
    }
    // Another column or kind: the old default may not fit any more.
    const same = initial && initial.kind === kind && initial.column === draft.column;
    onSave({ ...draft, default: same ? initial.default : {} });
  }

  return (
    <Modal title={initial ? "Edit filter" : "Add filter"} onClose={onClose} onSubmit={submit} wide>
      <fieldset className="dfilter-kinds">
        <legend className="eyebrow">Kind</legend>
        {KINDS.map((k) => (
          <label key={k} className={`dfilter-kind-choice${kind === k ? " selected" : ""}`}>
            <input type="radio" name="filter-kind" value={k} checked={kind === k} onChange={() => (setKind(k), setProblem(null))} />
            <strong>{KIND_LABELS[k]}</strong>
            <span className="small muted">{KIND_HINTS[k]}</span>
          </label>
        ))}
      </fieldset>

      {loadError && (
        <p className="alert alert-error">
          <strong>Error: </strong>
          {loadError}
        </p>
      )}

      {kind !== "time" && (
        <div className="inline-controls dfilter-source">
          <label>
            Dataset
            <select
              value={datasetId ?? ""}
              onChange={(e) => {
                setDatasetId(Number(e.target.value));
                setColumn("");
              }}
              disabled={!choices}
              aria-label="Dataset"
            >
              {(choices ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Column
            <select value={column} onChange={(e) => (setColumn(e.target.value), setProblem(null))} aria-label="Column" disabled={!dataset}>
              <option value="">Pick a column…</option>
              {columns.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.label || c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {problem && (
        <p className="alert alert-error small" role="alert">
          <strong>Error: </strong>
          {problem}
        </p>
      )}

      <label>
        Label <span className="muted">(optional)</span>
        <input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "time" ? "Time range" : column || "Label"} />
      </label>

      {kind === "values" && others.length > 0 && (
        <fieldset className="dfilter-targets">
          <legend className="eyebrow">Limited by</legend>
          <p className="small muted dfilter-hint">Only offer values that match these filters' current values (e.g. City: only the cities of the chosen Country).</p>
          {others.map((o) => (
            <label key={o.id} className="checkbox">
              <input
                type="checkbox"
                checked={dependsOn.includes(o.id)}
                onChange={() => setDependsOn((d) => (d.includes(o.id) ? d.filter((x) => x !== o.id) : [...d, o.id]))}
              />
              {filterLabel(o)}
              {o.kind !== "time" && o.column && dataset && !dataset.columns.some((c) => c.name === o.column) && (
                <span className="small muted"> · this dataset has no “{o.column}” column: no effect</span>
              )}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="dfilter-targets">
        <legend className="eyebrow">Applies to</legend>
        <label className="checkbox">
          <input type="radio" name="filter-targets" checked={targets === null} onChange={() => setTargets(null)} />
          {kind === "time" ? "Every chart with a time column" : `Every chart whose dataset has a column named “${column || "…"}”`}
        </label>
        <label className="checkbox">
          <input type="radio" name="filter-targets" checked={targets !== null} onChange={() => setTargets(charts.map((c) => c.id).filter((id) => fits(id)))} />
          Only the charts picked below
        </label>
        <ul className="dfilter-chart-list">
          {charts.map((c) => {
            const known = chartDatasets[c.id] !== undefined;
            const ok = fits(c.id);
            const on = targets === null ? ok : targets.includes(c.id);
            return (
              <li key={c.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={targets === null}
                    onChange={() => setTargets((t) => (t ?? []).includes(c.id) ? (t ?? []).filter((x) => x !== c.id) : [...(t ?? []), c.id])}
                  />
                  {c.name}
                  {known && !ok && <span className="small muted"> · its dataset has no such column: not filtered</span>}
                </label>
              </li>
            );
          })}
          {charts.length === 0 && <li className="small muted">No charts on this dashboard yet.</li>}
        </ul>
      </fieldset>

      <ModalActions>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary">
          {initial ? "Save filter" : "Add filter"}
        </button>
      </ModalActions>
    </Modal>
  );

  function fits(chartId: number): boolean {
    const d = chartDatasets[chartId];
    return d ? datasetFits(draft, d) : true;
  }
}
