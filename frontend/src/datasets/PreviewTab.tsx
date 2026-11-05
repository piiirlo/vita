import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, isQueryErrorDetail, previewDataset } from "../api.ts";
import ResultsPane, { type RunState } from "../sqllab/ResultsPane.tsx";
import { errorText } from "./format.ts";

type Props = {
  datasetId: number;
  title: string;
  /** Changes when the dataset was saved or synced, so the preview reloads. */
  reloadKey: number;
};

/** The first 100 rows of the dataset, in the SQL Lab results grid. */
export default function PreviewTab({ datasetId, title, reloadKey }: Props) {
  const [run, setRun] = useState<RunState | undefined>(undefined);
  const [sql, setSql] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setRun((prev) => ({
      status: "running",
      startedAt: Date.now(),
      previous: prev?.status === "done" ? prev.result : null,
    }));
    try {
      const result = await previewDataset(datasetId, current.signal);
      if (controller.current !== current) return;
      setSql(result.sql);
      setRun({ status: "done", result });
    } catch (err) {
      if (controller.current !== current) return;
      if (current.signal.aborted) setRun({ status: "stopped" });
      else if (err instanceof ApiError && isQueryErrorDetail(err.detail)) setRun({ status: "error", error: err.detail });
      else setRun({ status: "error", error: { kind: "other", message: errorText(err), line: null, column: null } });
    }
  }, [datasetId]);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load, reloadKey]);

  function stop() {
    const current = controller.current;
    controller.current = null;
    current?.abort();
    setRun({ status: "stopped" });
  }

  return (
    <div>
      <div className="preview-toolbar">
        <button className="small" onClick={() => void load()} disabled={run?.status === "running"}>
          Refresh
        </button>
        {sql && (
          <code className="small muted preview-sql" title={sql}>
            {sql}
          </code>
        )}
      </div>
      <div className="preview-grid">
        <ResultsPane run={run} title={title} onStop={stop} />
      </div>
    </div>
  );
}
