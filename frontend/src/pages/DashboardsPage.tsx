import { useEffect, useState } from "react";
import { LayoutDashboard, SearchX } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  listDashboards,
  type DashboardListItem,
} from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { errorText, relativeTime } from "../datasets/format.ts";
import SaveDialog from "../sqllab/SaveDialog.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import { toast } from "../components/toast.ts";
import EmptyState from "../components/EmptyState.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import PageHeader from "../shell/PageHeader.tsx";

export default function DashboardsPage() {
  usePageTitle("Dashboards");
  const navigate = useNavigate();
  const location = useLocation();
  const askedToCreate = (location.state as { createDashboard?: boolean } | null)?.createDashboard === true;
  const [dashboards, setDashboards] = useState<DashboardListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<DashboardListItem | null>(null);
  const [creating, setCreating] = useState(askedToCreate);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      listDashboards(search.trim() || undefined)
        .then((data) => {
          if (cancelled) return;
          setDashboards(data);
          setError(null);
        })
        .catch((err: unknown) => !cancelled && setError(errorText(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, reloadKey]);

  async function create(name: string, description: string) {
    const created = await createDashboard({ name, description: description || null, layout: [], refresh_interval: "off" });
    void navigate(`/dashboards/${created.id}?edit=1`);
  }

  async function duplicate(d: DashboardListItem) {
    try {
      const copy = await duplicateDashboard(d.id);
      toast.success(`Created "${copy.name}".`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(`Couldn't duplicate: ${errorText(err)}`);
    }
  }

  async function confirmDelete(d: DashboardListItem) {
    await deleteDashboard(d.id);
    toast.success(`Deleted "${d.name}".`);
    setToDelete(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Spaces"
        title="Dashboards"
        actions={
          <>
            <Input
                type="search"
                className="w-56"
                placeholder="Search dashboards…"
                aria-label="Search dashboards"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            <Button variant="primary" onClick={() => setCreating(true)}>
              New dashboard
            </Button>
          </>
        }
      />

      {error && <p className="alert alert-error">{error}</p>}
      {dashboards === null && !error && <p className="muted">Loading…</p>}

      {dashboards?.length === 0 &&
        (search.trim() ? (
          <EmptyState icon={SearchX} title={`No dashboards match “${search.trim()}”`}>Try a different word.</EmptyState>
        ) : (
          <EmptyState
            icon={LayoutDashboard}
            title="No dashboards yet"
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New dashboard
              </Button>
            }
          >
            Put your charts side by side on a grid.
          </EmptyState>
        ))}

      {dashboards && dashboards.length > 0 && (
        <div className="list-cards">
          {dashboards.map((d, index) => (
            <article key={d.id} className="list-card card-hover stagger-item" data-enter={Math.min(index, 12)}>
              <span className="eyebrow">Space</span>
              <Link to={`/dashboards/${d.id}`} className="list-card-title">
                {d.name}
              </Link>
              {d.description && <p className="list-card-desc">{d.description}</p>}
              <div className="list-card-stats">
                <div className="list-card-stat">
                  <span>Charts</span>
                  <span>{d.chart_count}</span>
                </div>
                <div className="list-card-stat">
                  <span>Last updated</span>
                  <span title={new Date(d.updated_at).toLocaleString()}>{relativeTime(d.updated_at)}</span>
                </div>
              </div>
              <div className="list-card-actions">
                <button onClick={() => void duplicate(d)} aria-label={`Duplicate ${d.name}`}>
                  Duplicate
                </button>
                <button className="danger" onClick={() => setToDelete(d)} aria-label={`Delete ${d.name}`}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {creating && (
        <SaveDialog
          title="New dashboard"
          initialName=""
          initialDescription=""
          onSave={create}
          onCancel={() => setCreating(false)}
        />
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete dashboard"
          confirmLabel="Delete"
          onConfirm={() => confirmDelete(toDelete)}
          onCancel={() => setToDelete(null)}
        >
          <p>
            Delete the dashboard <strong>{toDelete.name}</strong>? This cannot be undone. Its charts are not affected.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
