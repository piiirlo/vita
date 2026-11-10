import { Command } from "cmdk";
import {
  ChartLine,
  CodeXml,
  Database,
  FilePlus2,
  LayoutDashboard,
  LogOut,
  Network,
  Plus,
  Search,
  Activity,
  SunMoon,
  FileCode2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  listCharts,
  listDashboards,
  listDatasets,
  listSavedQueries,
  type DashboardListItem,
  type DatasetListItem,
  type SavedChart,
  type SavedQuery,
} from "../api.ts";
import { useAuth } from "../auth/auth.ts";
import type { SqlLabLocationState } from "../datasets/sqlLabLink.ts";
import { toggleTheme } from "../theme/theme.ts";
import { setCommandPaletteOpen as setOpen, useCommandPaletteOpen as useOpen } from "./commandPaletteStore.ts";

// ---------- the palette ----------

type Data = {
  dashboards: DashboardListItem[];
  charts: SavedChart[];
  datasets: DatasetListItem[];
  queries: SavedQuery[];
};
const EMPTY: Data = { dashboards: [], charts: [], datasets: [], queries: [] };

const valueOr = <T,>(r: PromiseSettledResult<T[]>): T[] => (r.status === "fulfilled" ? r.value : []);

/** The palette itself (lazy-loaded by CommandPaletteHost): jump to any page, dashboard, chart, dataset or saved query, or run an action. */
export default function CommandPalette() {
  const isOpen = useOpen();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [data, setData] = useState<Data>(EMPTY);
  const [loading, setLoading] = useState(false);

  // Fresh lists every time it opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled([listDashboards(), listCharts(), listDatasets(), listSavedQueries()]).then(
      ([dashboards, charts, datasets, queries]) => {
        if (cancelled) return;
        setData({
          dashboards: valueOr(dashboards),
          charts: valueOr(charts),
          datasets: valueOr(datasets),
          queries: valueOr(queries),
        });
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }
  const go = (to: string, state?: unknown) => run(() => void navigate(to, state === undefined ? undefined : { state }));
  const openInSqlLab = (title: string, sql: string, connectionId: number | null) => {
    const state: SqlLabLocationState = { openTab: { title, sql, connectionId, schema: null } };
    go("/sql-lab", state);
  };

  return (
    <Command.Dialog
      open={isOpen}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="anim-fade fixed inset-0 z-[90] bg-overlay backdrop-blur-[2px]"
      contentClassName="anim-pop fixed left-1/2 top-[14vh] z-[91] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-card border border-border-strong bg-surface-raised text-text shadow-[0_30px_90px_-30px_var(--shadow)]"
    >
      <div className="flex items-center gap-3 border-b border-border px-5">
        <Search size={18} className="shrink-0 text-accent" aria-hidden />
        <Command.Input
          autoFocus
          placeholder="Jump to a dashboard, chart, dataset or query…"
          className="h-14 flex-1 border-0 bg-transparent font-sans text-[15px] text-text outline-none placeholder:text-faint"
        />
        <kbd className="rounded-pill border border-border-strong px-2 py-1 font-mono text-[11px] text-muted">Esc</kbd>
      </div>
      <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-muted [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px]">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted">
          {loading ? "Loading…" : "Nothing matches. Try another word."}
        </Command.Empty>

        <Command.Group heading="Pages">
          <Item icon={<LayoutDashboard size={16} />} onSelect={() => go("/dashboards")}>Dashboards</Item>
          <Item icon={<CodeXml size={16} />} onSelect={() => go("/sql-lab")}>SQL Lab</Item>
          <Item icon={<ChartLine size={16} />} onSelect={() => go("/charts")}>Charts</Item>
          <Item icon={<Database size={16} />} onSelect={() => go("/datasets")}>Datasets</Item>
          <Item icon={<Network size={16} />} onSelect={() => go("/connections")}>Connections</Item>
          <Item icon={<Activity size={16} />} onSelect={() => go("/status")}>Status</Item>
        </Command.Group>

        <Command.Group heading="Actions">
          <Item icon={<Plus size={16} />} onSelect={() => go("/dashboards", { createDashboard: true })}>New dashboard</Item>
          <Item icon={<Plus size={16} />} onSelect={() => go("/charts/new")}>New chart</Item>
          <Item icon={<FilePlus2 size={16} />} onSelect={() => openInSqlLab("Untitled", "", null)} keywords={["sql", "tab"]}>
            New query
          </Item>
          <Item icon={<Plus size={16} />} onSelect={() => go("/datasets/new")}>New dataset</Item>
          <Item icon={<Plus size={16} />} onSelect={() => go("/connections/new")}>New connection</Item>
          <Item icon={<SunMoon size={16} />} onSelect={() => run(toggleTheme)} keywords={["dark", "light", "mode"]}>
            Toggle theme
          </Item>
          <Item icon={<LogOut size={16} />} onSelect={() => run(() => void logout().then(() => navigate("/login")))}>
            Log out
          </Item>
        </Command.Group>

        {data.dashboards.length > 0 && (
          <Command.Group heading="Dashboards">
            {data.dashboards.map((d) => (
              <Item key={`d${d.id}`} value={`dashboard ${d.name} ${d.id}`} icon={<LayoutDashboard size={16} />} onSelect={() => go(`/dashboards/${d.id}`)}>
                {d.name}
              </Item>
            ))}
          </Command.Group>
        )}
        {data.charts.length > 0 && (
          <Command.Group heading="Charts">
            {data.charts.map((c) => (
              <Item key={`c${c.id}`} value={`chart ${c.name} ${c.id}`} icon={<ChartLine size={16} />} onSelect={() => go(`/charts/${c.id}`)} hint={c.dataset_name}>
                {c.name}
              </Item>
            ))}
          </Command.Group>
        )}
        {data.datasets.length > 0 && (
          <Command.Group heading="Datasets">
            {data.datasets.map((d) => (
              <Item key={`s${d.id}`} value={`dataset ${d.name} ${d.id}`} icon={<Database size={16} />} onSelect={() => go(`/datasets/${d.id}`)}>
                {d.name}
              </Item>
            ))}
          </Command.Group>
        )}
        {data.queries.length > 0 && (
          <Command.Group heading="Saved queries">
            {data.queries.map((q) => (
              <Item
                key={`q${q.id}`}
                value={`query ${q.name} ${q.id}`}
                icon={<FileCode2 size={16} />}
                onSelect={() => openInSqlLab(q.name, q.sql, q.connection_id)}
                hint={q.connection_name ?? undefined}
              >
                {q.name}
              </Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

function Item({
  children,
  icon,
  onSelect,
  value,
  keywords,
  hint,
}: {
  children: ReactNode;
  icon: ReactNode;
  onSelect(): void;
  value?: string;
  keywords?: string[];
  hint?: string;
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-control px-3 py-2.5 text-sm text-text data-[selected=true]:bg-hover data-[selected=true]:shadow-[inset_2px_0_0_var(--accent)]"
    >
      <span className="text-muted" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="font-mono text-xs text-muted">{hint}</span>}
    </Command.Item>
  );
}
