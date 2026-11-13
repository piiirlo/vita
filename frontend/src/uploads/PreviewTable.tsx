import type { DateOrder, UploadColumnPreview, UploadPreview, UploadReadOptions } from "../api.ts";
import { DATE_FORMAT_LABELS } from "../datasets/format.ts";
import { readableDate, typeLabel } from "./uploads.ts";

type Props = {
  preview: UploadPreview;
  options: UploadReadOptions;
  busy: boolean;
  /** Change how a date column is read (day / month order). */
  onDateOrder?(index: number, order: DateOrder): void;
};

/** The first 100 rows as read. Values that don't fit their column's type are marked (dashed
 * underline + a note for screen readers, not color alone); left-out columns are dimmed.
 * Date columns show each value as it will be imported ("9 Nov 2013": never ambiguous), with
 * the detected format in the header and a way to change it. */
export default function PreviewTable({ preview, options, busy, onDateOrder }: Props) {
  const bad = new Set(preview.bad_cells.map(([r, c]) => `${r}:${c}`));
  const name = (i: number) => options.columns?.find((c) => c.index === i)?.name ?? preview.columns[i]?.name ?? "";
  const shownDate = (col: UploadColumnPreview | undefined, value: string): string | null => {
    if (!col || col.ignore || !col.date_order || (col.type !== "date" && col.type !== "datetime")) return null;
    return readableDate(value, col.date_order, col.type === "datetime");
  };
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
                  {!c.ignore && (c.type === "date" || c.type === "datetime") && (
                    <DateFormat column={c} label={name(c.index)} onDateOrder={onDateOrder} />
                  )}
                  {!c.ignore && c.years === "name" && <span className="col-note">years: a time column</span>}
                  {!c.ignore && (c.null_words ?? 0) > 0 && (
                    <span className="col-note" title="Words like N/A or null are read as empty values">
                      {c.null_words} N/A → empty
                    </span>
                  )}
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
                  const date = value && !isBad ? shownDate(preview.columns[c], value) : null;
                  return (
                    <td
                      key={c}
                      className={`${isBad ? "cell-bad" : ""}${preview.columns[c]?.ignore ? " is-ignored" : ""}${date ? " cell-date" : ""}`}
                      title={isBad ? `Not a valid ${typeLabel(preview.columns[c]!.type).toLowerCase()}: it would be empty` : date ? `In the file: ${value}` : undefined}
                    >
                      {value === null || value === "" ? <span className="muted">—</span> : (date ?? value)}
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

/** "Day first: DD-MM-YYYY" under a date column's type, as a small select to change it (an
 * ambiguous column asks "Which order?"). */
function DateFormat({ column, label, onDateOrder }: { column: UploadColumnPreview; label: string; onDateOrder?(index: number, order: DateOrder): void }) {
  const order = column.date_order;
  if (!onDateOrder || column.locked) {
    return <span className="col-format">{order ? DATE_FORMAT_LABELS[order] : "Which order?"}</span>;
  }
  return (
    <select
      className={`col-format${order ? "" : " needs-answer"}`}
      aria-label={`Date format of ${label}`}
      value={order ?? ""}
      aria-invalid={order ? undefined : true}
      onChange={(e) => e.target.value && onDateOrder(column.index, e.target.value as DateOrder)}
    >
      {!order && <option value="">Which order?</option>}
      {(Object.keys(DATE_FORMAT_LABELS) as DateOrder[]).map((o) => (
        <option key={o} value={o}>
          {DATE_FORMAT_LABELS[o]}
        </option>
      ))}
    </select>
  );
}
