import { useEffect, useRef, useState } from "react";
import { Database, FileUp, SearchX } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { listDatasets, type DatasetListItem } from "../api.ts";
import DeleteDatasetDialog from "../datasets/DeleteDatasetDialog.tsx";
import { errorText, relativeTime } from "../datasets/format.ts";
import { usePageTitle } from "../components/usePageTitle.ts";
import EmptyState from "../components/EmptyState.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import PageHeader from "../shell/PageHeader.tsx";
import { ACCEPTED_FILES, setPendingFile, useFileDrop } from "../uploads/fileDrop.ts";

export default function DatasetsPage() {
  usePageTitle("Datasets");
  const [datasets, setDatasets] = useState<DatasetListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<DatasetListItem | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  // A file picked here or dropped anywhere on the page goes to the upload page.
  const openUpload = (file: File) => {
    setPendingFile(file);
    void navigate("/datasets/upload");
  };
  const dragging = useFileDrop(openUpload);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      listDatasets(search.trim() || undefined)
        .then((data) => {
          if (cancelled) return;
          setDatasets(data);
          setError(null);
        })
        .catch((err: unknown) => !cancelled && setError(errorText(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, reloadKey]);

  return (
    <div>
      <PageHeader
        eyebrow="Data"
        title="Datasets"
        actions={
          <>
            <Input
                type="search"
                className="w-56"
                placeholder="Search datasets…"
                aria-label="Search datasets"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            <Button onClick={() => fileInput.current?.click()}>
              <FileUp size={16} aria-hidden /> Upload file
            </Button>
            <Button asChild variant="primary">
              <Link to="/datasets/new">New dataset</Link>
            </Button>
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_FILES}
        className="sr-only"
        aria-label="Upload file"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) openUpload(file);
        }}
      />
      {dragging && (
        <div className="drop-overlay" role="status" aria-live="polite">
          <div className="drop-overlay-card">
            <FileUp size={32} aria-hidden />
            <p>Drop the file to make a dataset</p>
            <p className="muted small">CSV, TSV, TXT or Excel (.xlsx)</p>
          </div>
        </div>
      )}

      {error && <p className="alert alert-error">{error}</p>}
      {datasets === null && !error && <p className="muted">Loading…</p>}

      {datasets?.length === 0 &&
        (search.trim() ? (
          <EmptyState icon={SearchX} title={`No datasets match “${search.trim()}”`}>Try a different word.</EmptyState>
        ) : (
          <EmptyState
            icon={Database}
            title="No datasets yet"
            action={
              <Button asChild variant="primary">
                <Link to="/datasets/new">New dataset</Link>
              </Button>
            }
          >
            Pick a table, save a query from <Link to="/sql-lab">SQL Lab</Link>, or drop a CSV or Excel file here.
          </EmptyState>
        ))}

      {datasets && datasets.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Connection</th>
              <th>Source</th>
              <th className="num">Columns</th>
              <th>Last updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {datasets.map((d, index) => (
              <tr key={d.id} className="stagger-item" data-enter={Math.min(index, 12)}>
                <td>
                  <Link to={`/datasets/${d.id}`} className="row-title">
                    {d.name}
                  </Link>
                  {d.description && <div className="muted small">{d.description}</div>}
                </td>
                <td>{d.connection_name}</td>
                <td>
                  <span className="tag">{d.is_upload ? "file" : d.kind === "table" ? "table" : "SQL"}</span>{" "}
                  {d.kind === "table" && (
                    <span className="mono small">
                      {d.schema}.{d.table_name}
                    </span>
                  )}
                </td>
                <td className="num">{d.column_count}</td>
                <td title={new Date(d.updated_at).toLocaleString()}>{relativeTime(d.updated_at)}</td>
                <td className="actions">
                  <Link to={`/datasets/${d.id}`} className="button">
                    Edit
                  </Link>
                  <button className="danger" onClick={() => setToDelete(d)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {toDelete && (
        <DeleteDatasetDialog
          dataset={toDelete}
          onDeleted={() => {
            setToDelete(null);
            setReloadKey((k) => k + 1);
          }}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  );
}
