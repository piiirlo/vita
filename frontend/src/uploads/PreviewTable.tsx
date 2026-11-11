import type { UploadPreview, UploadReadOptions } from "../api.ts";
import { typeLabel } from "./uploads.ts";

/** The first 100 rows as read. Values that don't fit their column's type are marked (dashed
 * underline + a note for screen readers, not color alone); left-out columns are dimmed. */
export default function PreviewTable({ preview, options, busy }: { preview: UploadPreview; options: UploadReadOptions; busy: boolean }) {
  const bad = new Set(preview.bad_cells.map(([r, c]) => `${r}:${c}`));
  const name = (i: number) => options.columns?.find((c) => c.index === i)?.name ?? preview.columns[i]?.name ?? "";
  return (
    <section className={`upload-preview card${busy ? " is-busy" : ""}`} aria-busy={busy} aria-label="Preview">
      <div className="upload-preview-scroll">
        <table className="upload-table">
          <thead>
            <tr>
              <th scope="col" className="row-number">
                #
              </th>
              {preview.columns.map((c) => (
                <th key={c.index} scope="col" className={c.ignore ? "is-ignored" : ""}>
                  <span className="col-name">{name(c.index)}</span>
                  <span className="col-type">{c.ignore ? "left out" : typeLabel(c.type)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, r) => (
              <tr key={r}>
                <td className="row-number mono">{r + 1}</td>
                {row.map((value, c) => {
                  const isBad = bad.has(`${r}:${c}`);
                  return (
                    <td key={c} className={`${isBad ? "cell-bad" : ""}${preview.columns[c]?.ignore ? " is-ignored" : ""}`} title={isBad ? `Not a valid ${typeLabel(preview.columns[c]!.type).toLowerCase()}: it would be empty` : undefined}>
                      {value === null || value === "" ? <span className="muted">—</span> : value}
                      {isBad && <span className="sr-only"> (doesn’t fit the column type)</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.more_rows && <p className="muted small upload-preview-more">Showing the first {preview.rows.length} rows; all of them are imported.</p>}
    </section>
  );
}
