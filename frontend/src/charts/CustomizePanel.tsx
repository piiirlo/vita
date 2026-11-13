import { useId, type ReactNode } from "react";
import type { ChartQuery, Dataset, MetricRef, VizType } from "../api.ts";
import {
  colorRules,
  isPositiveNegative,
  NO_RULES_HINT,
  POSITIVE_NEGATIVE,
  rulesApply,
  TONE_LABELS,
  type ColorRule,
  type RuleTone,
} from "./colorRules.ts";
import { FORMAT_PRESETS, formatWithSpec, unavailableOptions, type CustomizeOption, type FormatPreset, type FormatSpec } from "./display.ts";
import {
  metricFormat,
  metricLabel,
  metricName,
  temporalColumns,
  type ChartState,
  type DisplayOptions,
  type GaugeBand,
  type GaugeTone,
} from "./model.ts";
import { comboSeries } from "./options.ts";

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

/** The look of a chart, grouped like the Data panel: Labels & numbers, Colors, Axes & legend,
 * Layout. Nothing here queries the database (except the trend line and the comparison, which
 * need data), so the chart redraws live while you edit; options that don't apply are
 * disabled with a hint, and groups with nothing for this chart type are left out. */
export default function CustomizePanel({ state, dataset, seriesNames, onDisplay, onQuery }: Props) {
  const { vizType, display, query } = state;
  const hints = unavailableOptions(state, dataset);
  const cartesian = vizType === "bar" || vizType === "line" || vizType === "area" || vizType === "combo";
  // Funnels show their numbers unless turned off.
  const valueLabelsOn = vizType === "funnel" ? display.value_labels !== false : Boolean(display.value_labels);
  const metrics = vizType === "table" && display.mode === "raw" ? [] : query.metrics;
  const namesTitle: Partial<Record<VizType, string>> = { pie: "Slice names", treemap: "Box names", scatter: "Color names", funnel: "Step names" };
  // Several lines / bars / slices / boxes / steps / point groups: each can get its own color.
  const ownColors = (cartesian && seriesNames.length > 1) || ["pie", "treemap", "funnel", "scatter"].includes(vizType);
  const axes = cartesian || vizType === "pie" || vizType === "scatter" || vizType === "histogram" || vizType === "heatmap" || vizType === "world_map" || vizType === "treemap" || vizType === "funnel";

  return (
    <div className="chart-controls customize-panel">
      <Group title="Labels & numbers">
        <label className="control">
          <span>Title</span>
          <input value={display.title ?? ""} placeholder="The chart's name" onChange={(e) => onDisplay({ title: e.target.value || undefined })} />
        </label>
        {(vizType === "big_number" || vizType === "gauge") && (
          <label className="control">
            <span>Subtitle</span>
            <input
              value={display.subtitle ?? ""}
              placeholder={query.metrics[0] ? metricLabel(query.metrics[0], dataset) : ""}
              onChange={(e) => onDisplay({ subtitle: e.target.value })}
            />
          </label>
        )}
        <div className="control">
          <span>Numbers</span>
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
        </div>
        <Check label="Value labels" checked={valueLabelsOn && !hints.value_labels} hint={hints.value_labels} onChange={(value_labels) => onDisplay({ value_labels })} />
        {(cartesian || vizType === "pie" || vizType === "treemap" || vizType === "scatter" || vizType === "funnel") && (
          <SeriesNames names={seriesNames} display={display} onDisplay={onDisplay} title={namesTitle[vizType]} />
        )}
        {vizType === "treemap" && seriesNames.length === 0 && <p className="control-hint">Run the chart to rename its boxes.</p>}
      </Group>

      <Group title="Colors">
        {(cartesian || vizType === "pie" || vizType === "histogram") && <ColorPicker display={display} hint={hints.single_color} onDisplay={onDisplay} />}
        {ownColors && <SeriesColors names={seriesNames} display={display} onDisplay={onDisplay} />}
        {rulesApply(vizType) ? (
          <ColorRulesEditor state={state} dataset={dataset} onDisplay={onDisplay} />
        ) : (
          <p className="control-hint">{NO_RULES_HINT[vizType]}.</p>
        )}
        {vizType === "pivot_table" && (
          <fieldset className="heat-colors">
            <legend className="control-heading-small">Heat colors</legend>
            <p className="control-hint">Cells get darker as the value grows (totals stay plain).</p>
            {query.metrics.map((m) => {
              const name = metricName(m);
              const on = (display.heat ?? []).includes(name);
              return (
                <Check
                  key={name}
                  label={metricLabel(m, dataset)}
                  checked={on}
                  onChange={(checked) => {
                    const heat = (display.heat ?? []).filter((h) => h !== name);
                    onDisplay({ heat: checked ? [...heat, name] : heat.length ? heat : undefined });
                  }}
                />
              );
            })}
          </fieldset>
        )}
        {vizType === "gauge" && <GaugeBands display={display} onDisplay={onDisplay} />}
      </Group>

      {axes && (
        <Group title="Axes & legend">
          <Check
            label="Axis titles"
            checked={display.axis_titles !== false && !hints.axis_titles}
            hint={hints.axis_titles}
            onChange={(on) => onDisplay({ axis_titles: on ? undefined : false })}
          />
          <Field label="Legend" hint={hints.legend}>
            {(props) => (
              <select {...props} value={display.legend ?? (vizType === "pie" ? "right" : "top")} onChange={(e) => onDisplay({ legend: e.target.value as DisplayOptions["legend"] })}>
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="right">Right</option>
                <option value="none">Hidden</option>
              </select>
            )}
          </Field>
          {vizType === "pie" && (
            <Field label="Sort slices">
              {(props) => (
                <select {...props} value={display.sort ?? "value"} onChange={(e) => onDisplay({ sort: e.target.value as "value" | "label" })}>
                  <option value="value">Biggest first</option>
                  <option value="label">By name</option>
                </select>
              )}
            </Field>
          )}
          {(vizType === "bar" || vizType === "combo") && (
            <Field label="Sort bars" hint={hints.sort}>
              {(props) => (
                <select {...props} value={display.sort ?? "value"} onChange={(e) => onDisplay({ sort: e.target.value as "value" | "label" })}>
                  <option value="value">By value (largest first)</option>
                  <option value="label">By label</option>
                </select>
              )}
            </Field>
          )}
          {cartesian && (
            <Field label="Series order">
              {(props) => (
                <select {...props} value={display.series_sort ?? "default"} onChange={(e) => onDisplay({ series_sort: e.target.value as DisplayOptions["series_sort"] })}>
                  <option value="default">As in the data</option>
                  <option value="value">Biggest first</option>
                  <option value="label">By name</option>
                </select>
              )}
            </Field>
          )}
          {vizType === "combo" && (
            <fieldset className="combo-series">
              <legend className="control-heading-small">Each metric</legend>
              {query.metrics.map((m, i) => {
                const name = metricName(m);
                const current = comboSeries(display, name, i);
                const set = (patch: Partial<typeof current>) => onDisplay({ combo: { ...display.combo, [name]: { ...current, ...patch } } });
                return (
                  <div key={name} className="combo-row">
                    <span className="combo-name">{metricLabel(m, dataset)}</span>
                    <select aria-label={`Draw ${metricLabel(m, dataset)} as`} value={current.type} onChange={(e) => set({ type: e.target.value as "bar" | "line" })}>
                      <option value="bar">Bars</option>
                      <option value="line">Line</option>
                    </select>
                    <select aria-label={`Axis of ${metricLabel(m, dataset)}`} value={current.axis} onChange={(e) => set({ axis: e.target.value as "left" | "right" })}>
                      <option value="left">Left axis</option>
                      <option value="right">Right axis</option>
                    </select>
                  </div>
                );
              })}
            </fieldset>
          )}
        </Group>
      )}

      <Group title="Layout">
        {vizType === "big_number" && <BigNumberLayout state={state} dataset={dataset} hints={hints} onDisplay={onDisplay} onQuery={onQuery} />}
        {vizType === "bar" && (
          <div className="checkbox-row">
            <Check label="Stacked" checked={Boolean(display.stacked)} hint={hints.stacked} onChange={(stacked) => onDisplay({ stacked })} />
            <Check label="Horizontal" checked={Boolean(display.horizontal)} onChange={(horizontal) => onDisplay({ horizontal })} />
          </div>
        )}
        {vizType === "area" && (
          <div className="control">
            <span>Stacking</span>
            <div className="segmented segmented-3" role="radiogroup" aria-label="Stacking">
              {(
                [
                  ["none", "Not stacked"],
                  ["stacked", "Stacked"],
                  ["percent", "100%"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={(display.stack ?? "none") === value}
                  className={(display.stack ?? "none") === value ? "active" : ""}
                  disabled={value !== "none" && Boolean(hints.stacked)}
                  title={value !== "none" ? hints.stacked : undefined}
                  onClick={() => onDisplay({ stack: value === "none" ? undefined : value })}
                >
                  {label}
                </button>
              ))}
            </div>
            {hints.stacked && <p className="control-hint">{hints.stacked}</p>}
          </div>
        )}
        {(vizType === "line" || vizType === "area" || vizType === "combo") && (
          <Check label="Show points" checked={Boolean(display.show_points)} onChange={(show_points) => onDisplay({ show_points })} />
        )}
        {vizType === "pie" && <Check label="Donut (total in the middle)" checked={Boolean(display.donut)} onChange={(donut) => onDisplay({ donut })} />}
        {vizType === "funnel" && <FunnelOrder state={state} seriesNames={seriesNames} onDisplay={onDisplay} />}
        {vizType === "gauge" && <GaugeRange display={display} onDisplay={onDisplay} />}
        {!["big_number", "bar", "area", "line", "combo", "pie", "funnel", "gauge"].includes(vizType) && (
          <p className="control-hint">This chart fills its space; resize its tile on a dashboard.</p>
        )}
      </Group>
    </div>
  );
}

/** One group of options: a title over a card. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="customize-group" aria-labelledby={id}>
      <h3 className="section-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

// ---------- conditional colors ----------

/** Rules that color values above / below a threshold; "Positive / negative" in one click.
 * Colored values always show their value with ▲ / ▼ (never color alone). */
function ColorRulesEditor({ state, dataset, onDisplay }: { state: ChartState; dataset: Dataset; onDisplay(p: Partial<DisplayOptions>): void }) {
  const { display, query } = state;
  const rules = colorRules(display);
  const posNeg = isPositiveNegative(rules);
  const set = (next: ColorRule[]) => onDisplay({ color_rules: next.length ? next : undefined, color_below: undefined, color_above: undefined });
  const patch = (i: number, p: Partial<ColorRule>) => set(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const metrics = query.metrics;
  return (
    <fieldset className="color-rules">
      <legend className="control-heading-small">Conditional colors</legend>
      <div className="inline-controls">
        <button type="button" className="small" aria-pressed={posNeg} onClick={() => set(posNeg ? [] : POSITIVE_NEGATIVE)}>
          Positive / negative
        </button>
        <button
          type="button"
          className="small"
          onClick={() => {
            const last = rules.at(-1);
            set([...rules, { when: last?.when === "below" ? "above" : "below", value: last?.value ?? 0, tone: last?.tone === "danger" ? "success" : "danger" }]);
          }}
        >
          + Add rule
        </button>
      </div>
      {rules.length === 0 && <p className="control-hint">No rules: values use the chart's colors.</p>}
      {rules.map((rule, i) => {
        const n = i + 1;
        return (
          <div key={i} className="rule-row">
            <select aria-label={`Rule ${n}: when the value is`} value={rule.when} onChange={(e) => patch(i, { when: e.target.value as ColorRule["when"] })}>
              <option value="above">Above</option>
              <option value="below">Below</option>
            </select>
            <input
              type="number"
              aria-label={`Rule ${n}: threshold`}
              value={Number.isFinite(rule.value) ? rule.value : ""}
              onChange={(e) => patch(i, { value: e.target.value === "" ? NaN : Number(e.target.value) })}
            />
            <select aria-label={`Rule ${n}: color`} value={rule.tone} onChange={(e) => patch(i, { tone: e.target.value as RuleTone })}>
              {(Object.keys(TONE_LABELS) as RuleTone[]).map((t) => (
                <option key={t} value={t}>
                  {TONE_LABELS[t]}
                </option>
              ))}
            </select>
            {metrics.length > 1 && (
              <select aria-label={`Rule ${n}: metric`} value={rule.metric ?? ""} onChange={(e) => patch(i, { metric: e.target.value || null })}>
                <option value="">Every metric</option>
                {metrics.map((m) => (
                  <option key={metricName(m)} value={metricName(m)}>
                    {metricLabel(m, dataset)}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="small" aria-label={`Remove rule ${n}`} onClick={() => set(rules.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        );
      })}
      {rules.length > 0 && <p className="control-hint">The first matching rule wins. Colored values always show their value with ▲ or ▼.</p>}
    </fieldset>
  );
}

/** A color per series / slice / box / step, picked by hand ("Auto" = the palette order). */
function SeriesColors({ names, display, onDisplay }: { names: string[]; display: DisplayOptions; onDisplay(p: Partial<DisplayOptions>): void }) {
  if (names.length === 0) return <p className="control-hint">Run the chart to pick a color per series.</p>;
  const shown = names.slice(0, 20);
  return (
    <fieldset className="series-colors">
      <legend className="control-heading-small">Color of each</legend>
      {shown.map((name) => {
        const picked = display.series_colors?.[name] ?? null;
        return (
          <label key={name} className="series-name-row">
            <span className="series-color-name" title={name}>
              <span className="swatch swatch-small" aria-hidden style={{ background: picked ? `var(--series-${picked})` : "transparent" }} />
              <span className="mono">{display.series_labels?.[name] || name}</span>
            </span>
            <select
              aria-label={`Color of ${name}`}
              value={picked ?? ""}
              onChange={(e) => {
                const colors = { ...display.series_colors };
                if (e.target.value) colors[name] = Number(e.target.value);
                else delete colors[name];
                onDisplay({ series_colors: Object.keys(colors).length ? colors : undefined });
              }}
            >
              <option value="">Auto</option>
              {SERIES_COLOR_NAMES.map((colorName, i) => (
                <option key={colorName} value={i + 1}>
                  {colorName}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {names.length > shown.length && <p className="control-hint">The first {shown.length} can get their own color here.</p>}
    </fieldset>
  );
}

// ---------- funnel ----------

function FunnelOrder({ state, seriesNames, onDisplay }: { state: ChartState; seriesNames: string[]; onDisplay(p: Partial<DisplayOptions>): void }) {
  const { display } = state;
  const custom = display.funnel_order === "custom";
  // The chosen order first (steps still in the data), then the others as loaded.
  const listed = (display.funnel_steps ?? []).filter((n) => seriesNames.includes(n));
  const order = [...listed, ...seriesNames.filter((n) => !listed.includes(n))];
  const move = (i: number, by: -1 | 1) => {
    const next = [...order];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    onDisplay({ funnel_order: "custom", funnel_steps: next });
  };
  return (
    <>
      <div className="control">
        <span>Step order</span>
        <div className="segmented" role="radiogroup" aria-label="Step order">
          {(
            [
              ["value", "Largest first"],
              ["custom", "My order"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={(display.funnel_order ?? "value") === value}
              className={(display.funnel_order ?? "value") === value ? "active" : ""}
              onClick={() => onDisplay(value === "custom" ? { funnel_order: "custom", funnel_steps: order } : { funnel_order: undefined })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {custom && (
        <ol className="step-order" aria-label="Steps in order">
          {order.map((name, i) => (
            <li key={name}>
              <span className="mono">{display.series_labels?.[name] || name}</span>
              <button type="button" className="small" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="small" aria-label={`Move ${name} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
            </li>
          ))}
        </ol>
      )}
      {seriesNames.length === 0 && <p className="control-hint">Run the chart to see and order its steps.</p>}
    </>
  );
}

// ---------- gauge ----------

const TONES: { value: GaugeTone; label: string }[] = [
  { value: "danger", label: "Red" },
  { value: "warning", label: "Amber" },
  { value: "success", label: "Green" },
];

function GaugeRange({ display, onDisplay }: { display: DisplayOptions; onDisplay(p: Partial<DisplayOptions>): void }) {
  return (
    <div className="inline-controls gauge-range">
      <NumberField label="Min" value={display.gauge_min} placeholder="0" onChange={(gauge_min) => onDisplay({ gauge_min })} />
      <NumberField label="Max" value={display.gauge_max} placeholder="Auto" onChange={(gauge_max) => onDisplay({ gauge_max })} />
      <NumberField label="Target" value={display.gauge_target} placeholder="None" onChange={(gauge_target) => onDisplay({ gauge_target })} />
    </div>
  );
}

function GaugeBands({ display, onDisplay }: { display: DisplayOptions; onDisplay(p: Partial<DisplayOptions>): void }) {
  const bands = display.gauge_bands ?? [];
  const setBands = (next: GaugeBand[]) => onDisplay({ gauge_bands: next.length ? next : undefined });
  return (
      <fieldset className="gauge-bands">
        <legend className="control-heading-small">Color bands</legend>
        {bands.length === 0 && <p className="control-hint">No bands: the arc fills up to the value.</p>}
        {bands.map((band, i) => (
          <div key={i} className="band-row">
            <span className="muted small">up to</span>
            <input
              type="number"
              aria-label={`Band ${i + 1} up to`}
              value={Number.isFinite(band.to) ? band.to : ""}
              onChange={(e) => setBands(bands.map((b, j) => (j === i ? { ...b, to: Number(e.target.value) } : b)))}
            />
            <select aria-label={`Band ${i + 1} color`} value={band.tone} onChange={(e) => setBands(bands.map((b, j) => (j === i ? { ...b, tone: e.target.value as GaugeTone } : b)))}>
              {TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button type="button" className="small" aria-label={`Remove band ${i + 1}`} onClick={() => setBands(bands.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="small"
          onClick={() => {
            const last = bands[bands.length - 1];
            const tone = TONES[Math.min(bands.length, TONES.length - 1)]!.value;
            setBands([...bands, { to: last ? last.to * 2 || 100 : (display.gauge_max ?? 100) / 2, tone }]);
          }}
        >
          + Add band
        </button>
      </fieldset>
  );
}

function NumberField({ label, value, placeholder, onChange }: { label: string; value: number | null | undefined; placeholder: string; onChange(v: number | null): void }) {
  return (
    <label className="control">
      <span>{label}</span>
      <input
        type="number"
        aria-label={`Gauge ${label.toLowerCase()}`}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const n = e.target.value === "" ? null : Number(e.target.value);
          onChange(n === null || Number.isFinite(n) ? n : null);
        }}
      />
    </label>
  );
}

// ---------- big number ----------

const POSITIONS_H = [
  ["left", "Left"],
  ["center", "Center"],
  ["right", "Right"],
] as const;
const POSITIONS_V = [
  ["top", "Top"],
  ["middle", "Middle"],
  ["bottom", "Bottom"],
] as const;

function BigNumberLayout({
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
        <span>Position</span>
        <div className="segmented segmented-3" role="radiogroup" aria-label="Horizontal position">
          {POSITIONS_H.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={(display.align ?? "center") === value}
              className={(display.align ?? "center") === value ? "active" : ""}
              onClick={() => onDisplay({ align: value === "center" ? undefined : value })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="segmented segmented-3" role="radiogroup" aria-label="Vertical position">
          {POSITIONS_V.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={(display.valign ?? "middle") === value}
              className={(display.valign ?? "middle") === value ? "active" : ""}
              onClick={() => onDisplay({ valign: value === "middle" ? undefined : value })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="control-hint">The subtitle, comparison and trend line follow the number.</p>
      </div>
      <Check
        label="Compare with the previous period"
        checked={Boolean(display.compare_previous) && !hints.compare_previous}
        hint={hints.compare_previous}
        onChange={(compare_previous) => onDisplay({ compare_previous })}
      />
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
    </>
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
