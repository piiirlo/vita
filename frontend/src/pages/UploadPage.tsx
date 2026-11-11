import { FileUp, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  cancelUpload,
  getDataset,
  getUpload,
  importUpload,
  previewUpload,
  uploadFile,
  type Dataset,
  type UploadJob,
  type UploadPreview,
  type UploadReadOptions,
} from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { toast } from "../components/toast.ts";
import { Button } from "../components/ui/button.tsx";
import { ErrorAlert } from "../components/ui/alert.tsx";
import { Input } from "../components/ui/input.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import { errorText } from "../datasets/format.ts";
import PageHeader from "../shell/PageHeader.tsx";
import AdjustPanel from "../uploads/AdjustPanel.tsx";
import { ACCEPTED_FILES, takePendingFile, useFileDrop } from "../uploads/fileDrop.ts";
import PreviewTable from "../uploads/PreviewTable.tsx";
import { formatBytes, problemsKey } from "../uploads/uploads.ts";

type Phase =
  | { kind: "pick" }
  | { kind: "uploading"; share: number }
  | { kind: "preview" }
  | { kind: "importing"; job: UploadJob | null }
  | { kind: "report"; job: UploadJob }
  | { kind: "failed"; message: string };

const POLL_MS = 400;
const PREVIEW_DEBOUNCE_MS = 250;

type Target = { datasetId: number; mode: "replace" | "append" };

/** `?dataset=<id>&mode=replace|append`: the file is for that uploaded dataset. */
function targetOf(params: URLSearchParams): Target | null {
  const datasetId = Number(params.get("dataset"));
  const mode = params.get("mode");
  if (!Number.isInteger(datasetId) || datasetId <= 0) return null;
  return mode === "replace" || mode === "append" ? { datasetId, mode } : null;
}

const rowsText = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

/** File -> preview -> dataset (or new data for an uploaded dataset: Replace file / Append
 * file). Everything is detected; "Adjust how the file is read" holds the details and opens by
 * itself when something looks wrong. */
export default function UploadPage() {
  const [params] = useSearchParams();
  const target = useMemo(() => targetOf(params), [params]);
  usePageTitle(target ? (target.mode === "replace" ? "Replace file" : "Append file") : "Upload file");
  const navigate = useNavigate();
  const [targetDataset, setTargetDataset] = useState<Dataset | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [options, setOptions] = useState<UploadReadOptions | null>(null);
  const [datasetName, setDatasetName] = useState("");
  const [onError, setOnError] = useState<"null" | "stop">("null");
  const [panelOpen, setPanelOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const seenProblems = useRef<string | null>(null);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Show a preview; a new set of problems opens the adjust panel by itself (in the same
   * update, so the panel never flashes closed). */
  const showPreview = useCallback((result: UploadPreview) => {
    setPreview(result);
    setOptions(result.options);
    const key = problemsKey(result.problems);
    if (result.problems.length && key !== seenProblems.current) setPanelOpen(true);
    seenProblems.current = key;
  }, []);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    getDataset(target.datasetId)
      .then((d) => !cancelled && setTargetDataset(d))
      .catch((err: unknown) => !cancelled && setPhase({ kind: "failed", message: errorText(err) }));
    return () => {
      cancelled = true;
    };
  }, [target]);

  const start = useCallback(async (picked: File) => {
    setFile(picked);
    setPreview(null);
    setPreviewError(null);
    seenProblems.current = null;
    setPhase({ kind: "uploading", share: 0 });
    try {
      const result = await uploadFile(picked, (share) => setPhase({ kind: "uploading", share }), undefined, target ?? undefined);
      showPreview(result);
      setDatasetName(result.dataset_name);
      setPhase({ kind: "preview" });
    } catch (err) {
      setPhase({ kind: "failed", message: errorText(err) });
    }
  }, [showPreview, target]);

  // A file picked or dropped on the Datasets page.
  useEffect(() => {
    const pending = takePendingFile();
    if (pending) void start(pending);
  }, [start]);

  const dragging = useFileDrop((dropped) => void start(dropped), phase.kind === "pick" || phase.kind === "failed" || phase.kind === "preview");

  /** Re-read the file with new options (debounced; only the latest answer is shown). */
  function reread(next: UploadReadOptions, immediate = false) {
    setOptions(next);
    if (!preview) return;
    clearTimeout(timer.current);
    const run = async () => {
      const id = ++request.current;
      setRefreshing(true);
      try {
        const result = await previewUpload(preview.upload_id, next);
        if (id !== request.current) return;
        showPreview(result);
        setPreviewError(null);
      } catch (err) {
        if (id === request.current) setPreviewError(errorText(err));
      } finally {
        if (id === request.current) setRefreshing(false);
      }
    };
    if (immediate) void run();
    else timer.current = setTimeout(() => void run(), PREVIEW_DEBOUNCE_MS);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  async function create() {
    if (!preview || !options) return;
    setPhase({ kind: "importing", job: null });
    try {
      let job = await importUpload(preview.upload_id, { options, dataset_name: datasetName.trim(), on_error: onError });
      while (job.status === "importing" || job.status === "pending") {
        setPhase({ kind: "importing", job });
        await new Promise((r) => setTimeout(r, POLL_MS));
        job = await getUpload(job.id);
      }
      if (job.status === "done" && job.dataset_id !== null) {
        if (job.bad_values.length) {
          setPhase({ kind: "report", job });
        } else {
          const rows = rowsText(job.row_count ?? 0);
          toast.success(
            preview.mode === "replace"
              ? `Replaced the data of "${preview.dataset_name}" (${rows}).`
              : preview.mode === "append"
                ? `Appended ${rows} to "${preview.dataset_name}".`
                : `Created the dataset "${datasetName.trim()}" (${rows}).`,
          );
          void navigate(`/datasets/${job.dataset_id}`);
        }
      } else {
        setPhase({ kind: "failed", message: job.error ?? "The import failed." });
      }
    } catch (err) {
      // e.g. the name is taken: back to the preview, the file is still there.
      setPhase({ kind: "preview" });
      setPreviewError(errorText(err));
    }
  }

  function startOver() {
    if (preview && phase.kind === "preview") void cancelUpload(preview.upload_id).catch(() => undefined);
    setPreview(null);
    setFile(null);
    setPhase({ kind: "pick" });
  }

  const blocking = preview?.problems.filter((p) => p.blocking) ?? [];
  const canCreate =
    phase.kind === "preview" && preview !== null && blocking.length === 0 && (target !== null || datasetName.trim() !== "") && !refreshing;
  const targetName = targetDataset?.name ?? preview?.target?.name ?? "the dataset";
  const actionLabel = target?.mode === "replace" ? "Replace data" : target?.mode === "append" ? "Append rows" : "Create dataset";
  const fileColumns = targetDataset?.columns.filter((c) => !c.is_missing).map((c) => c.name) ?? [];

  return (
    <div className="upload-page">
      <PageHeader
        eyebrow={
          <>
            <Link to="/datasets" className="crumb">
              Datasets
            </Link>{" "}
            {target ? (
              <>
                /{" "}
                <Link to={`/datasets/${target.datasetId}`} className="crumb">
                  {targetName}
                </Link>{" "}
                / {target.mode === "replace" ? "Replace file" : "Append file"}
              </>
            ) : (
              "/ Upload"
            )}
          </>
        }
        title={
          preview
            ? preview.file_name
            : target?.mode === "replace"
              ? `Replace the data of ${targetName}`
              : target?.mode === "append"
                ? `Add rows to ${targetName}`
                : "Upload a file"
        }
        search={false}
        actions={
          phase.kind === "preview" && (
            <>
              <Button onClick={startOver}>Choose another file</Button>
              <Button variant="primary" disabled={!canCreate} onClick={() => (target?.mode === "replace" ? setConfirmReplace(true) : void create())}>
                {actionLabel}
              </Button>
            </>
          )
        }
      />

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FILES}
        className="sr-only"
        aria-label="Choose a file"
        tabIndex={-1}
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (picked) void start(picked);
        }}
      />

      {(phase.kind === "pick" || phase.kind === "failed") && (
        <div className={`upload-drop${dragging ? " is-dragging" : ""}`}>
          <FileUp size={28} aria-hidden className="upload-drop-icon" />
          <p className="upload-drop-title">Drop a CSV, TSV or Excel file here</p>
          <p className="muted small">CSV / TSV separated by comma, semicolon, tab or pipe · Excel .xlsx · everything is detected</p>
          {target && fileColumns.length > 0 && (
            <p className="small upload-target-columns">
              {target.mode === "replace" ? "The file replaces every row. " : "The rows are added. "}
              Its columns are matched by name: <span className="mono">{fileColumns.join(", ")}</span>
            </p>
          )}
          <Button variant="primary" onClick={() => inputRef.current?.click()}>
            Choose a file
          </Button>
          {phase.kind === "failed" && (
            <ErrorAlert className="upload-error">
              {phase.message}
              {file && (
                <>
                  {" "}
                  <button type="button" className="link-button" onClick={() => void start(file)}>
                    Try again
                  </button>
                </>
              )}
            </ErrorAlert>
          )}
        </div>
      )}

      {phase.kind === "uploading" && (
        <Progress label={`Uploading ${file?.name ?? "the file"}`} share={phase.share} detail={file ? formatBytes(file.size) : ""} />
      )}

      {phase.kind === "importing" && (
        <Progress
          label={
            target?.mode === "replace"
              ? `Replacing the data of “${targetName}”`
              : target?.mode === "append"
                ? `Adding rows to “${targetName}”`
                : `Creating the dataset “${datasetName.trim()}”`
          }
          share={phase.job?.progress ?? 0}
          detail={phase.job ? `${phase.job.rows_done.toLocaleString("en-US")} rows` : "Starting…"}
        />
      )}

      {phase.kind === "report" && (
        <section className="card upload-report" aria-label="Import report">
          <h2>
            <TriangleAlert size={18} aria-hidden /> {target ? "Done" : "Created"}, with some empty values
          </h2>
          <p>
            {(phase.job.row_count ?? 0).toLocaleString("en-US")} rows were imported. These values didn’t fit their column’s
            type and were left empty:
          </p>
          <ul>
            {phase.job.bad_values.map((b) => (
              <li key={b.column}>
                <strong className="mono">{b.column}</strong>: {b.count.toLocaleString("en-US")}{" "}
                {b.count === 1 ? "value" : "values"}, e.g.{" "}
                {b.examples.map((e) => `“${e.value}” (row ${e.row})`).join(", ")}
              </li>
            ))}
          </ul>
          <Button variant="primary" onClick={() => void navigate(`/datasets/${phase.job.dataset_id}`)}>
            Open the dataset
          </Button>
        </section>
      )}

      {phase.kind === "preview" && preview && options && (
        <>
          <section className="upload-summary card">
            {preview.target ? (
              <p className="upload-into">
                <span className="eyebrow">{preview.mode === "replace" ? "Replaces the data of" : "Adds rows to"}</span>
                <Link to={`/datasets/${preview.target.id}`}>{preview.target.name}</Link>
                <span className="muted small mono"> · {preview.target.table_name}</span>
              </p>
            ) : (
              <label className="upload-name">
                <span className="eyebrow">Dataset name</span>
                <Input value={datasetName} onChange={(e) => setDatasetName(e.target.value)} aria-label="Dataset name" maxLength={200} />
              </label>
            )}
            <p className="muted small mono">
              {formatBytes(preview.file_size)} · {preview.columns.filter((c) => !c.ignore).length} columns ·{" "}
              {preview.more_rows ? `first ${preview.sampled_rows.toLocaleString("en-US")} rows checked` : rowsText(preview.sampled_rows)}
            </p>
            {previewError && <ErrorAlert>{previewError}</ErrorAlert>}
            {blocking.length > 0 && !panelOpen && (
              <p className="upload-blocked" role="note">
                <TriangleAlert size={14} aria-hidden /> {blocking[0]!.message}
              </p>
            )}
          </section>

          <AdjustPanel
            open={panelOpen}
            onOpenChange={setPanelOpen}
            preview={preview}
            options={options}
            onError={onError}
            onOnError={setOnError}
            onOptions={reread}
            onLocalOptions={setOptions}
          />

          <PreviewTable preview={preview} options={options} busy={refreshing} />
        </>
      )}

      {confirmReplace && preview && (
        <ConfirmDialog
          title="Replace the data"
          confirmLabel="Replace data"
          onConfirm={() => {
            setConfirmReplace(false);
            void create();
          }}
          onCancel={() => setConfirmReplace(false)}
        >
          <p>
            Every row of <strong>{preview.dataset_name}</strong> is replaced by the rows of <strong>{preview.file_name}</strong>.
            Column settings, metrics, charts and dashboards keep working.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function Progress({ label, share, detail }: { label: string; share: number; detail: string }) {
  const pct = Math.round(Math.min(Math.max(share, 0), 1) * 100);
  return (
    <section className="upload-progress card" aria-live="polite">
      <p className="upload-progress-label">{label}</p>
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted small mono">
        {pct}% · {detail}
      </p>
    </section>
  );
}

