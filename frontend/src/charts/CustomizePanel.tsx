import { useId, type ReactNode } from "react";
import type { ChartQuery, Dataset, MetricRef } from "../api.ts";
import { FORMAT_PRESETS, formatWithSpec, unavailableOptions, type CustomizeOption, type FormatPreset, type FormatSpec } from "./display.ts";
import { metricFormat, metricLabel, metricName, temporalColumns, type ChartState, type DisplayOptions } from "./model.ts";

type Props = {
  state: ChartState;
  dataset: Dataset;
  /** Original series names of the loaded result (bar / line), for renaming. */
  seriesNames: string[];
  onDisplay(patch: Partial<DisplayOptions>): void;
  /** Only for "Show trend line", which needs a time grain. */
  onQuery(patch: Partial<ChartQuery>): void;
};

const SERIES_COLOR_NAMES = ["orange", "olive", "dark olive", "slate blue", "ochre", "violet", "teal", "berry", "stone", "night blue"];

/** The look of a chart. Nothing here queries the database (except the trend line and the
 * comparison, which need data); options that don't apply are disabled with a hint. */
export default function CustomizePanel({ state, dataset, seriesNames, onDisplay, onQuery }: Props) {
  const { vizType, display, query } = state;
  const hints = unavailableOptions(state, dataset);
  const cartesian = vizType === "bar" || vizType === "line";
  const metrics = vizType === "table" && display.mode === "raw" ? [] : query.metrics;

  return (
    <div className="chart-controls customize-panel">
      <section>
        <label className="control">
          <span>Title</span>
          <input
            value={display.title ?? ""}
            placeholder="The chart's name"
            onChange={(e) => onDisplay({ title: e.target.value || undefined })}
          />
        </label>
        {vizType === "big_number" && (
          <label className="control">
            <span>Subtitle</span>
            <input
              value={display.subtitle ?? ""}
              placeholder={query.metrics[0] ? metricLabel(query.metrics[0], dataset) : ""}
              onChange={(e) => onDisplay({ subtitle: e.target.value })}
            />
          </label>
        )}
      </section>

      <section>
        <h3 className="control-heading">Numbers</h3>
        {metrics.length === 0 && <p className="control-hint">Raw records are shown as they are.</p>}
        {metrics.map((m) => (
          <FormatEditor
            key={metricName(m)}
            metric={m}
            dataset={dataset}
            showName={metrics.length > 1}
            spec={display.formats?.[metricName(m)] ?? null}
            onChange={(spec) => {
              const formats = { ...display.formats };
              if (spec) formats[metricName(m)] = spec;
              else delete formats[metricName(m)];
              onDisplay({ formats: Object.keys(formats).length ? formats : undefined });
            }}
          />
        ))}
      </section>

      {vizType === "big_number" && (
        <BigNumberSection state={state} dataset={dataset} hints={hints} onDisplay={onDisplay} onQuery={onQuery} />
      )}

      {vizType === "pie" && (
        <section>
          <h3 className="control-heading">Pie</h3>
          <Check label="Donut (total in the middle)" checked={Boolean(display.donut)} onChange={(donut) => onDisplay({ donut })} />
          <Field label="Sort slices">
            {(props) => (
              <select {...props} value={display.sort ?? "value"} onChange={(e) => onDisplay({ sort: e.target.value as "value" | "label" })}>
                <option value="value">Biggest first</option>
                <option value="label">By name</option>
              </select>
            )}
          </Field>
          <ColorPicker display={display} hint={hints.single_color} onDisplay={onDisplay} />
          <SeriesNames names={seriesNames} display={display} onDisplay={onDisplay} title="Slice names" />
        </section>
      )}

      {cartesian && (
        <section>
          <h3 className="control-heading">{vizType === "bar" ? "Bars" : "Lines"}</h3>
          {vizType === "bar" && (
            <div className="checkbox-row">
              <Check label="Stacked" checked={Boolean(display.stacked)} hint={hints.stacked} onChange={(stacked) => onDisplay({ stacked })} />
              <Check label="Horizontal" checked={Boolean(display.horizontal)} onChange={(horizontal) => onDisplay({ horizontal })} />
            </div>
          )}
          {vizType === "line" && (
            <Check label="Show points" checked={Boolean(display.show_points)} onChange={(show_points) => onDisplay({ show_points })} />
          )}
          {vizType === "bar" && (
            <Field label="Sort bars" hint={hints.sort}>
              {(props) => (
                <select
                  {...props}
                  value={display.sort ?? "value"}
                  onChange={(e) => onDisplay({ sort: e.target.value as "value" | "label" })}
                >
                  <option value="value">By value (largest first)</option>
                  <option value="label">By label</option>
                </select>
              )}
            </Field>
          )}
          <Field label="Series order">
            {(props) => (
              <select
                {...props}
                value={display.series_sort ?? "default"}
                onChange={(e) => onDisplay({ series_sort: e.target.value as DisplayOptions["series_sort"] })}
              >
                <option value="default">As in the data</option>
                <option value="value">Biggest first</option>
                <option value="label">By name</option>
              </select>
            )}
          </Field>
          <ColorPicker display={display} hint={hints.single_color} onDisplay={onDisplay} />
          <SeriesNames names={seriesNames} display={display} onDisplay={onDisplay} />
        </section>
      )}

      <section>
        <h3 className="control-heading">Axes and legend</h3>
        <Check
          label="Axis titles"
          checked={display.axis_titles !== false && !hints.axis_titles}
          hint={hints.axis_titles}
          onChange={(on) => onDisplay({ axis_titles: on ? undefined : false })}
        />
        <Check
          label="Value labels"
          checked={Boolean(display.value_labels) && !hints.value_labels}
          hint={hints.value_labels}
          onChange={(value_labels) => onDisplay({ value_labels })}
        />
        <Field label="Legend" hint={hints.legend}>
          {(props) => (
            <select
              {...props}
              value={display.legend ?? (vizType === "pie" ? "right" : "top")}
              onChange={(e) => onDisplay({ legend: e.target.value as DisplayOptions["legend"] })}
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="right">Right</option>
              <option value="none">Hidden</option>
            </select>
          )}
        </Field>
      </section>
    </div>
  );
}

// ---------- big number ----------

function BigNumberSection({
  state,
  dataset,
  hints,
  onDisplay,
  onQuery,
}: {
  state: ChartState;
  dataset: Dataset;
  hints: Partial<Record<CustomizeOption, string>>;
  onDisplay(patch: Partial<DisplayOptions>): void;
  onQuery(patch: Partial<ChartQuery>): void;
}) {
  const { display, query } = state;
  const sizes = [
    ["auto", "Auto"],
    ["s", "S"],
    ["m", "M"],
    ["l", "L"],
  ] as const;
  return (
    <>
      <section>
        <h3 className="control-heading">Big number</h3>
        <div className="control">
          <span>Font size</span>
          <div className="segmented segmented-4" role="radiogroup" aria-label="Font size">
            {sizes.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={(display.font_size ?? "auto") === value}
                className={(display.font_size ?? "auto") === value ? "active" : ""}
                onClick={() => onDisplay({ font_size: value === "auto" ? undefined : value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="control">
          <span>Conditional color</span>
          <div className="inline-controls">
            <ThresholdInput label="Below" title="Red (with ↓) when the value is below this" value={display.color_below} onChange={(color_below) => onDisplay({ color_below })} />
            <ThresholdInput label="Above" title="Green (with ↑) when the value is above this" value={display.color_above} onChange={(color_above) => onDisplay({ color_above })} />
          </div>
        </div>
        <Check
          label="Compare with the previous period"
          checked={Boolean(display.compare_previous) && !hints.compare_previous}
          hint={hints.compare_previous}
          onChange={(compare_previous) => onDisplay({ compare_previous })}
        />
      </section>
      <section>
        <h3 className="control-heading">Trend line</h3>
        <Check
          label="Show trend line"
          checked={Boolean(display.show_trend)}
          hint={hints.show_trend}
          onChange={(on) => {
            onDisplay({ show_trend: on });
            if (on && !query.time?.grain) {
              const column = query.time?.column ?? dataset.main_time_column ?? temporalColumns(dataset)[0]?.name ?? null;
              onQuery({ time: { column, grain: "month", range: query.time?.range ?? { kind: "none" } } });
            }
          }}
        />
        <Check
          label="Show first and last date"
          checked={Boolean(display.trend_dates) && !hints.trend_dates}
          hint={hints.trend_dates}
          onChange={(trend_dates) => onDisplay({ trend_dates })}
        />
        <p className="control-hint">Hover the trend line to see each period's date and value.</p>
      </section>
    </>
  );
}

function ThresholdInput({ label, title, value, onChange }: { label: string; title: string; value: number | null | undefined; onChange(v: number | null): void }) {
  return (
    <label className="control threshold" title={title}>
      <span>{label}</span>
      <input
        type="number"
        aria-label={`Color when ${label.toLowerCase()}`}
        value={value ?? ""}
        placeholder="—"
        onChange={(e) => {
          const n = e.target.value === "" ? null : Number(e.target.value);
          onChange(n === null || Number.isFinite(n) ? n : null);
        }}
      />
    </label>
  );
}

// ---------- numbers ----------

function FormatEditor({
  metric,
  dataset,
  showName,
  spec,
  onChange,
}: {
  metric: MetricRef;
  dataset: Dataset;
  showName: boolean;
  spec: FormatSpec | null;
  onChange(spec: FormatSpec | null): void;
}) {
  const label = metricLabel(metric, dataset);
  const saved = metricFormat(metric, dataset);
  const current: FormatSpec = spec ?? { preset: "number" };
  const patch = (p: Partial<FormatSpec>) => onChange({ ...current, ...p });
  const example = current.preset === "percent" ? 0.1254 : 67416.513;
  return (
    <fieldset className="format-editor" aria-label={`Number format for ${label}`}>
      {showName && <legend className="format-editor-name">{label}</legend>}
      <div className="inline-controls">
        <label className="control">
          <span>Format</span>
          <select
            aria-label={`Format of ${label}`}
            value={spec ? spec.preset : ""}
            onChange={(e) => onChange(e.target.value ? { ...current, preset: e.target.value as FormatPreset } : null)}
          >
            <option value="">{saved ? `Metric's own (${saved})` : "Default"}</option>
            {FORMAT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} ({p.example})
              </option>
            ))}
          </select>
        </label>
        {spec && spec.preset !== "custom" && (
          <label className="control">
            <span>Decimals</span>
            <select
              aria-label={`Decimals of ${label}`}
              value={spec.decimals ?? ""}
              onChange={(e) => patch({ decimals: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">Auto</option>
              {[0, 1, 2, 3, 4].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {spec?.preset === "currency" && (
        <label className="control">
          <span>Currency symbol</span>
          <input aria-label={`Currency symbol of ${label}`} value={spec.symbol ?? "$"} maxLength={4} onChange={(e) => patch({ symbol: e.target.value })} />
        </label>
      )}
      {spec?.preset === "custom" && (
        <label className="control">
          <span>Custom format</span>
          <input
            aria-label={`Custom format of ${label}`}
            className="mono"
            value={spec.custom ?? ""}
            placeholder="0,0.000"
            onChange={(e) => patch({ custom: e.target.value })}
          />
        </label>
      )}
      {spec && (
        <div className="inline-controls">
          <label className="control">
            <span>Prefix</span>
            <input aria-label={`Prefix of ${label}`} value={spec.prefix ?? ""} maxLength={12} onChange={(e) => patch({ prefix: e.target.value || undefined })} />
          </label>
          <label className="control">
            <span>Suffix</span>
            <input aria-label={`Suffix of ${label}`} value={spec.suffix ?? ""} maxLength={12} onChange={(e) => patch({ suffix: e.target.value || undefined })} />
          </label>
        </div>
      )}
      {spec && (
        <p className="control-hint" data-testid="format-example">
          e.g. <span className="mono">{formatWithSpec(example, spec)}</span>
        </p>
      )}
    </fieldset>
  );
}

// ---------- colors and series ----------

function ColorPicker({ display, hint, onDisplay }: { display: DisplayOptions; hint?: string; onDisplay(p: Partial<DisplayOptions>): void }) {
  const hintId = useId();
  const single = !hint && Boolean(display.color);
  return (
    <div className="control">
      <span>Colors</span>
      <div className="segmented" role="radiogroup" aria-label="Colors">
        <button type="button" role="radio" aria-checked={!single} className={!single ? "active" : ""} onClick={() => onDisplay({ color: undefined })}>
          Palette
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={single}
          className={single ? "active" : ""}
          disabled={Boolean(hint)}
          aria-describedby={hint ? hintId : undefined}
          onClick={() => onDisplay({ color: display.color ?? 1 })}
        >
          Single color
        </button>
      </div>
      {single && (
        <div className="swatches" role="radiogroup" aria-label="Series color">
          {SERIES_COLOR_NAMES.map((colorName, i) => (
            <button
              key={colorName}
              type="button"
              role="radio"
              aria-checked={display.color === i + 1}
              aria-label={colorName}
              title={colorName}
              className="swatch"
              style={{ background: `var(--series-${i + 1})` }}
              onClick={() => onDisplay({ color: i + 1 })}
            />
          ))}
        </div>
      )}
      {hint && (
        <p className="control-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

function SeriesNames({
  names,
  display,
  onDisplay,
  title = "Series names",
}: {
  names: string[];
  display: DisplayOptions;
  onDisplay(p: Partial<DisplayOptions>): void;
  title?: string;
}) {
  if (names.length === 0) return null;
  const shown = names.slice(0, 20);
  return (
    <fieldset className="series-names">
      <legend className="control-heading-small">{title}</legend>
      {shown.map((name) => (
        <label key={name} className="series-name-row">
          <span className="mono" title={name}>
            {name}
          </span>
          <input
            aria-label={`Name for ${name}`}
            value={display.series_labels?.[name] ?? ""}
            placeholder={name}
            onChange={(e) => {
              const labels = { ...display.series_labels };
              if (e.target.value) labels[name] = e.target.value;
              else delete labels[name];
              onDisplay({ series_labels: Object.keys(labels).length ? labels : undefined });
            }}
          />
        </label>
      ))}
      {names.length > shown.length && <p className="control-hint">The first {shown.length} series can be renamed here.</p>}
    </fieldset>
  );
}

// ---------- small parts ----------

/** A checkbox; disabled with its hint (why it doesn't apply) when `hint` is set. */
function Check({ label, checked, hint, onChange }: { label: string; checked: boolean; hint?: string; onChange(v: boolean): void }) {
  const hintId = useId();
  return (
    <div className={`check-field${hint ? " is-disabled" : ""}`}>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={Boolean(hint)}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {hint && (
        <p className="control-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** A labelled control; disabled with its hint when `hint` is set. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children(props: { "aria-label": string; disabled: boolean; "aria-describedby"?: string }): ReactNode;
}) {
  const hintId = useId();
  return (
    <div className={`control${hint ? " is-disabled" : ""}`}>
      <span>{label}</span>
      {children({ "aria-label": label, disabled: Boolean(hint), ...(hint ? { "aria-describedby": hintId } : {}) })}
      {hint && (
        <p className="control-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
