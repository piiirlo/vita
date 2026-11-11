import { Search } from "lucide-react";
import { useState } from "react";
import type { VizType } from "../api.ts";
import { Modal } from "../components/ui/dialog.tsx";
import { searchViz, VIZ_GROUPS } from "./vizGallery.ts";
import { vizLabel } from "./vizTypes.ts";
import VizThumb from "./VizThumb.tsx";

/** The current chart type, and a gallery (grouped, searchable) to change it. */
export default function ChartTypePicker({ value, onChange }: { value: VizType; onChange(viz: VizType): void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const found = searchViz(search);
  const pick = (viz: VizType) => {
    setOpen(false);
    setSearch("");
    if (viz !== value) onChange(viz);
  };

  return (
    <div className="control">
      <span id="chart-type-label">Chart type</span>
      <button type="button" className="viz-current" aria-haspopup="dialog" aria-labelledby="chart-type-label chart-type-value" onClick={() => setOpen(true)}>
        <VizThumb viz={value} />
        <span id="chart-type-value" className="viz-current-name">
          {vizLabel(value)}
        </span>
        <span className="viz-current-change">Change</span>
      </button>
      {open && (
        <Modal title="Chart type" wide onClose={() => setOpen(false)} className="viz-gallery-dialog">
          <label className="viz-search">
            <Search size={16} aria-hidden />
            <input
              autoFocus
              type="search"
              aria-label="Search chart types"
              placeholder="Search: donut, kpi, totals…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && found[0]) {
                  e.preventDefault();
                  pick(found[0].value);
                }
              }}
            />
          </label>
          <div className="viz-gallery" role="radiogroup" aria-label="Chart type">
            {VIZ_GROUPS.map((group) => {
              const items = found.filter((v) => v.group === group);
              if (items.length === 0) return null;
              return (
                <section key={group} className="viz-group" aria-label={group}>
                  <h3 className="eyebrow">{group}</h3>
                  <div className="viz-cards">
                    {items.map((v) => (
                      <button
                        key={v.value}
                        type="button"
                        role="radio"
                        aria-checked={v.value === value}
                        aria-label={v.label}
                        aria-describedby={`viz-desc-${v.value}`}
                        className={`viz-card${v.value === value ? " active" : ""}`}
                        onClick={() => pick(v.value)}
                      >
                        <VizThumb viz={v.value} />
                        <span className="viz-card-name">{v.label}</span>
                        <span id={`viz-desc-${v.value}`} className="viz-card-desc">
                          {v.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
            {found.length === 0 && <p className="muted small">No chart type matches “{search}”.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
