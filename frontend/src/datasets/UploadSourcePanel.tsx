import { FileSpreadsheet } from "lucide-react";
import { Link } from "react-router";
import type { Dataset, UploadEvent } from "../api.ts";
import { Button } from "../components/ui/button.tsx";
import { relativeTime } from "./format.ts";

const MODE_LABEL: Record<UploadEvent["mode"], string> = { create: "Uploaded", replace: "Replaced", append: "Appended" };

const rows = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

/** Where an uploaded dataset's data came from, with Replace file / Append file. */
export default function UploadSourcePanel({ dataset }: { dataset: Dataset }) {
  const source = dataset.upload_source;
  const link = (mode: "replace" | "append") => `/datasets/upload?dataset=${dataset.id}&mode=${mode}`;
  return (
    <section className="upload-source" aria-label="Uploaded file">
      <FileSpreadsheet size={18} aria-hidden className="upload-source-icon" />
      <div className="upload-source-body">
        {source ? (
          <>
            <p>
              <span className="mono upload-source-file">{source.file_name}</span>
              <span className="muted small">
                {" "}
                · {rows(source.row_count)} · {MODE_LABEL[source.history[0]!.mode].toLowerCase()}{" "}
                <time dateTime={source.uploaded_at} title={new Date(source.uploaded_at).toLocaleString()}>
                  {relativeTime(source.uploaded_at)}
                </time>
                {source.uploaded_by && ` by ${source.uploaded_by}`}
              </span>
            </p>
            {source.history.length > 1 && (
              <details className="upload-history">
                <summary className="small">History ({source.history.length})</summary>
                <ol className="small">
                  {source.history.map((e, i) => (
                    <li key={i}>
                      <span className="eyebrow">{MODE_LABEL[e.mode]}</span> <span className="mono">{e.file_name}</span>{" "}
                      <span className="muted">
                        · {e.mode === "append" ? `+${rows(e.rows)}` : rows(e.rows)} ·{" "}
                        <time dateTime={e.uploaded_at} title={new Date(e.uploaded_at).toLocaleString()}>
                          {relativeTime(e.uploaded_at)}
                        </time>
                        {e.uploaded_by && ` by ${e.uploaded_by}`}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
        ) : (
          <p className="muted small">Made from an uploaded file.</p>
        )}
      </div>
      <div className="upload-source-actions">
        <Button asChild size="sm">
          <Link to={link("replace")}>Replace file</Link>
        </Button>
        <Button asChild size="sm">
          <Link to={link("append")}>Append file</Link>
        </Button>
      </div>
    </section>
  );
}
