import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  ApiError,
  createSavedQuery,
  isQueryErrorDetail,
  listConnections,
  runQuery,
  updateSavedQuery,
  type Connection,
  type DbType,
  type QueryHistoryItem,
  type SavedQuery,
} from "../api.ts";
import SaveAsDatasetDialog from "../datasets/SaveAsDatasetDialog.tsx";
import { isSqlLabLocationState } from "../datasets/sqlLabLink.ts";
import HistoryPanel from "../sqllab/HistoryPanel.tsx";
import { setCompletionContext, setupMonaco } from "../sqllab/monacoSetup.ts";
import ResultsPane, { type RunState } from "../sqllab/ResultsPane.tsx";
import { qualifiedName } from "../sqllab/completion.ts";
import type { RunOffset } from "../sqllab/results.ts";
import SaveDialog from "../sqllab/SaveDialog.tsx";
import SavedQueriesPanel from "../sqllab/SavedQueriesPanel.tsx";
import { getSchemas, getTables } from "../sqllab/schemaCache.ts";
import SchemaTree from "../sqllab/SchemaTree.tsx";
import SqlEditor, { type EditorError, type RunTarget, type SqlEditorHandle } from "../sqllab/SqlEditor.tsx";
import {
  createTab,
  isDirty,
  loadSetting,
  loadTabs,
  saveSetting,
  saveTabs,
  tabsReducer,
  type Tab,
  type TabInput,
} from "../sqllab/tabs.ts";

setupMonaco();

const LIMITS = [100, 1000, 10000] as const;
const LIMIT_KEY = "vita.sqllab.limit";
const HEIGHT_KEY = "vita.sqllab.editorHeight";
type SidePanel = "schema" | "saved" | "history";

const isLimit = (v: unknown): v is number => LIMITS.includes(v as (typeof LIMITS)[number]);
const isHeight = (v: unknown): v is number => typeof v === "number" && v >= 100 && v <= 2000;

/** Default schema: the MySQL database, else "public" if it has tables, else the first one. */
async function defaultSchema(conn: Connection, schemas: string[]): Promise<string | null> {
  if (conn.db_type === "mysql" && schemas.includes(conn.database)) return conn.database;
  if (schemas.includes("public")) {
    const tables = await getTables(conn.id, "public").catch(() => []);
    if (tables.length > 0 || schemas.length === 1) return "public";
  }
  return schemas.find((s) => s !== "public") ?? schemas[0] ?? null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function SqlLabPage() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(tabsReducer, undefined, () => loadTabs());
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [offsets, setOffsets] = useState<Record<string, RunOffset>>({});
  const [limit, setLimit] = useState(() => loadSetting(LIMIT_KEY, 1000, isLimit));
  const [editorHeight, setEditorHeight] = useState(() => loadSetting(HEIGHT_KEY, 300, isHeight));
  const [panel, setPanel] = useState<SidePanel>("schema");
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  const [historyKey, setHistoryKey] = useState(0);
  const [savedKey, setSavedKey] = useState(0);
  const [saveDialog, setSaveDialog] = useState<"new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [datasetDialog, setDatasetDialog] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const handledLocation = useRef<string | null>(null);

  const editorRef = useRef<SqlEditorHandle>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const stateRef = useRef(state);
  stateRef.current = state;

  const activeTab = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]!;
  const activeConnection = connections?.find((c) => c.id === activeTab.connectionId) ?? null;
  const dbType: DbType = activeConnection?.db_type ?? "postgresql";

  const updateTab = useCallback(
    (id: string, patch: TabInput) => dispatch({ type: "update", id, patch }),
    [],
  );

  // ---------- loading & persistence ----------

  useEffect(() => {
    listConnections()
      .then(setConnections)
      .catch((err: unknown) => setConnectionsError(messageOf(err)));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => saveTabs(state), 300);
    return () => clearTimeout(timer);
  }, [state]);

  // Give the active tab a connection if it has none (or its connection was deleted).
  useEffect(() => {
    if (!connections || connections.length === 0) return;
    if (!connections.some((c) => c.id === activeTab.connectionId)) {
      updateTab(activeTab.id, { connectionId: connections[0]!.id, schema: null });
    }
  }, [connections, activeTab.id, activeTab.connectionId, updateTab]);

  // Schemas for the picker; choose a default schema.
  useEffect(() => {
    if (!activeConnection) {
      setSchemaOptions([]);
      return;
    }
    let cancelled = false;
    const tabId = activeTab.id;
    getSchemas(activeConnection.id)
      .then(async (schemas) => {
        if (cancelled) return;
        setSchemaOptions(schemas);
        const current = stateRef.current.tabs.find((t) => t.id === tabId);
        if (current && (current.schema === null || !schemas.includes(current.schema))) {
          const schema = await defaultSchema(activeConnection, schemas);
          if (!cancelled) updateTab(tabId, { schema });
        }
      })
      .catch(() => !cancelled && setSchemaOptions([]));
    return () => {
      cancelled = true;
    };
  }, [activeConnection, activeTab.id, updateTab]);

  useEffect(() => {
    setCompletionContext({ connectionId: activeTab.connectionId, schema: activeTab.schema, dbType });
  }, [activeTab.connectionId, activeTab.schema, dbType]);

  // "Open in SQL Lab" from elsewhere (e.g. a dataset): open a new tab once, then clear the state
  // so a reload or Back doesn't open it again.
  useEffect(() => {
    if (handledLocation.current === location.key) return;
    handledLocation.current = location.key;
    if (!isSqlLabLocationState(location.state)) return;
    const { openTab } = location.state;
    const tab = createTab(stateRef.current.tabs, {
      title: openTab.title,
      sql: openTab.sql,
      connectionId: openTab.connectionId,
      schema: openTab.schema,
    });
    dispatch({ type: "add", tab });
    navigate(location.pathname, { replace: true, state: null });
  }, [location, navigate]);

  // ---------- running ----------

  const run = useCallback(
    async (tabId: string, explicit?: RunTarget) => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab || tab.connectionId === null) return;
      const target =
        explicit ??
        (tabId === stateRef.current.activeId ? editorRef.current?.getRunTarget() : null) ?? {
          sql: tab.sql,
          startLine: 1,
          startColumn: 1,
        };
      if (!target.sql.trim()) return;

      controllers.current.get(tabId)?.abort();
      const controller = new AbortController();
      controllers.current.set(tabId, controller);
      setOffsets((prev) => ({
        ...prev,
        [tabId]: { startLine: target.startLine, startColumn: target.startColumn },
      }));
      setRuns((prev) => {
        const before = prev[tabId];
        const previous =
          before?.status === "done" ? before.result : before?.status === "running" ? before.previous : null;
        return { ...prev, [tabId]: { status: "running", startedAt: Date.now(), previous } };
      });

      let next: RunState;
      try {
        const result = await runQuery(tab.connectionId, target.sql, limit, controller.signal);
        next = { status: "done", result };
      } catch (err) {
        if (controller.signal.aborted) {
          next = { status: "stopped" };
        } else if (err instanceof ApiError && isQueryErrorDetail(err.detail)) {
          next = { status: "error", error: err.detail };
        } else {
          next = {
            status: "error",
            error: { kind: "other", message: messageOf(err), line: null, column: null },
          };
        }
      }
      // A newer run (or Stop) may have replaced this one.
      if (controllers.current.get(tabId) === controller) {
        controllers.current.delete(tabId);
        setRuns((prev) => ({ ...prev, [tabId]: next }));
      }
      setHistoryKey((k) => k + 1);
    },
    [limit],
  );

  const stop = useCallback((tabId: string) => {
    const controller = controllers.current.get(tabId);
    if (!controller) return;
    controller.abort();
    controllers.current.delete(tabId);
    setRuns((prev) => ({ ...prev, [tabId]: { status: "stopped" } }));
  }, []);

  // Abort everything when leaving the page.
  useEffect(() => {
    const map = controllers.current;
    return () => map.forEach((c) => c.abort());
  }, []);

  // ---------- tabs ----------

  function addTab(partial: TabInput = {}): Tab {
    const tab = createTab(stateRef.current.tabs, {
      connectionId: activeTab.connectionId,
      schema: activeTab.schema,
      ...partial,
    });
    dispatch({ type: "add", tab });
    return tab;
  }

  function closeTab(tab: Tab) {
    if (isDirty(tab) && !window.confirm(`"${tab.title}" has unsaved changes. Close it anyway?`)) return;
    controllers.current.get(tab.id)?.abort();
    controllers.current.delete(tab.id);
    editorRef.current?.disposeModel(tab.id);
    setRuns(({ [tab.id]: _removed, ...rest }) => rest);
    dispatch({ type: "close", id: tab.id });
  }

  function preview(schema: string, table: string) {
    const sql = `SELECT *\nFROM ${qualifiedName(schema, table, dbType)}\nLIMIT 100`;
    const tab = addTab({ title: table, sql, schema });
    void run(tab.id, { sql, startLine: 1, startColumn: 1 });
  }

  function openSaved(query: SavedQuery) {
    const existing = stateRef.current.tabs.find((t) => t.savedQueryId === query.id);
    if (existing) {
      dispatch({ type: "select", id: existing.id });
      return;
    }
    addTab({
      title: query.name,
      sql: query.sql,
      connectionId: query.connection_id ?? activeTab.connectionId,
      schema: query.connection_id === activeTab.connectionId ? activeTab.schema : null,
      savedQueryId: query.id,
      savedSql: query.sql,
      description: query.description,
    });
  }

  function openHistory(item: QueryHistoryItem) {
    addTab({
      title: "From history",
      sql: item.sql,
      connectionId: item.connection_id ?? activeTab.connectionId,
    });
  }

  function onSavedDeleted(id: number) {
    for (const tab of stateRef.current.tabs) {
      if (tab.savedQueryId === id) updateTab(tab.id, { savedQueryId: null, savedSql: null });
    }
  }

  // ---------- saving ----------

  async function saveNew(name: string, description: string) {
    const tab = activeTab;
    const saved = await createSavedQuery({
      name,
      description: description || null,
      connection_id: tab.connectionId,
      sql: tab.sql,
    });
    updateTab(tab.id, {
      title: saved.name,
      description: saved.description,
      savedQueryId: saved.id,
      savedSql: saved.sql,
    });
    setSaveDialog(null);
    setSavedKey((k) => k + 1);
    flash(`Saved "${saved.name}".`);
  }

  async function save() {
    const tab = activeTab;
    if (!tab.sql.trim()) {
      flash("Nothing to save: the editor is empty.");
      return;
    }
    if (tab.savedQueryId === null) {
      setSaveDialog("new");
      return;
    }
    try {
      const saved = await updateSavedQuery(tab.savedQueryId, {
        name: tab.title,
        description: tab.description,
        connection_id: tab.connectionId,
        sql: tab.sql,
      });
      updateTab(tab.id, { savedSql: saved.sql });
      setSavedKey((k) => k + 1);
      flash(`Saved "${saved.name}".`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        updateTab(tab.id, { savedQueryId: null, savedSql: null });
        setSaveDialog("new"); // it was deleted meanwhile: save as a new one
      } else {
        flash(`Couldn't save: ${messageOf(err)}`);
      }
    }
  }

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(text: string) {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }

  // Ctrl+S saves the current tab.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- editor height splitter ----------

  function startResize(event: ReactMouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = editorHeight;
    let latest = startHeight;
    const onMove = (e: MouseEvent) => {
      latest = Math.min(Math.max(startHeight + e.clientY - startY, 100), window.innerHeight - 200);
      setEditorHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      saveSetting(HEIGHT_KEY, latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ---------- render ----------

  const activeRun = runs[activeTab.id];
  const activeOffset = offsets[activeTab.id];
  const editorError = useMemo<EditorError | null>(() => {
    if (activeRun?.status !== "error" || !activeOffset) return null;
    return { ...activeRun.error, offset: activeOffset };
  }, [activeRun, activeOffset]);
  const running = activeRun?.status === "running";

  if (connectionsError) {
    return <p className="alert alert-error page-pad">Couldn't load connections: {connectionsError}</p>;
  }
  if (connections === null) return <p className="muted page-pad">Loading…</p>;
  if (connections.length === 0) {
    return (
      <div className="card empty page-pad">
        <p>SQL Lab needs a database connection first.</p>
        <Link to="/connections/new" className="button primary">
          Add a connection
        </Link>
      </div>
    );
  }

  return (
    <div className="sqllab">
      <aside className="sqllab-sidebar">
        <div className="side-tabs" role="tablist">
          {(["schema", "saved", "history"] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={panel === p}
              className={panel === p ? "active" : ""}
              onClick={() => setPanel(p)}
            >
              {p === "schema" ? "Schema" : p === "saved" ? "Saved" : "History"}
            </button>
          ))}
        </div>
        <div className="side-body">
          {panel === "schema" && activeConnection && (
            <SchemaTree
              connectionId={activeConnection.id}
              dbType={dbType}
              schema={activeTab.schema}
              onInsert={(text) => editorRef.current?.insertText(text)}
              onPreview={preview}
            />
          )}
          {panel === "saved" && (
            <SavedQueriesPanel refreshKey={savedKey} onOpen={openSaved} onDeleted={onSavedDeleted} />
          )}
          {panel === "history" && (
            <HistoryPanel connectionId={activeTab.connectionId} refreshKey={historyKey} onOpen={openHistory} />
          )}
        </div>
      </aside>

      <section className="sqllab-main">
        <div className="tab-bar" role="tablist">
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTab.id}
              className={`query-tab${tab.id === activeTab.id ? " active" : ""}`}
              onClick={() => dispatch({ type: "select", id: tab.id })}
              onAuxClick={(e) => e.button === 1 && closeTab(tab)}
              title={tab.description ?? tab.title}
            >
              {runs[tab.id]?.status === "running" && <span className="spinner small" aria-hidden />}
              <span className="query-tab-title">{tab.title}</span>
              {isDirty(tab) && <span className="dirty-dot" title="Unsaved changes" />}
              <button
                className="query-tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="query-tab-add" title="New tab" aria-label="New tab" onClick={() => addTab()}>
            +
          </button>
        </div>

        <div className="sqllab-toolbar">
          <select
            aria-label="Connection"
            value={activeTab.connectionId ?? ""}
            onChange={(e) => {
              updateTab(activeTab.id, { connectionId: Number(e.target.value), schema: null });
              setRuns(({ [activeTab.id]: _old, ...rest }) => rest);
            }}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Schema"
            value={activeTab.schema ?? ""}
            onChange={(e) => updateTab(activeTab.id, { schema: e.target.value || null })}
          >
            {activeTab.schema === null && <option value="">schema…</option>}
            {schemaOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          {running ? (
            <button className="danger" onClick={() => stop(activeTab.id)}>
              ■ Stop
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => void run(activeTab.id)}
              title="Run (Ctrl+Enter). Runs only the selection if text is selected."
            >
              ▶ Run
            </button>
          )}
          <label className="inline-label">
            Limit
            <select
              aria-label="Row limit"
              value={limit}
              onChange={(e) => {
                const value = Number(e.target.value);
                setLimit(value);
                saveSetting(LIMIT_KEY, value);
              }}
            >
              {LIMITS.map((l) => (
                <option key={l} value={l}>
                  {l.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => {
              const problem = editorRef.current?.format(dbType);
              if (problem) flash(problem);
            }}
            title="Format SQL (selection or everything)"
          >
            Format
          </button>
          <button onClick={() => void save()} title="Save (Ctrl+S)">
            Save
          </button>
          {activeTab.savedQueryId !== null && (
            <button onClick={() => setSaveDialog("new")} title="Save a copy under a new name">
              Save as new
            </button>
          )}
          <button
            onClick={() => setDatasetDialog(true)}
            disabled={!activeTab.sql.trim() || activeTab.connectionId === null}
            title="Use this tab's query as a dataset for charts"
          >
            Save as dataset
          </button>
          <span className="spacer" />
          {notice && <span className="toolbar-notice">{notice}</span>}
          <span className="muted small kbd-hint">Ctrl+Enter to run</span>
        </div>

        <div className="editor-wrap" style={{ height: editorHeight }}>
          <SqlEditor
            ref={editorRef}
            path={activeTab.id}
            defaultValue={activeTab.sql}
            onChange={(sql) => updateTab(activeTab.id, { sql })}
            onRun={() => void run(stateRef.current.activeId)}
            error={editorError}
          />
        </div>
        <div className="splitter" onMouseDown={startResize} title="Drag to resize" />

        <ResultsPane run={activeRun} title={activeTab.title} onStop={() => stop(activeTab.id)} />
      </section>

      {saveDialog && (
        <SaveDialog
          initialName={activeTab.savedQueryId !== null ? `${activeTab.title} (copy)` : activeTab.title.startsWith("Query ") ? "" : activeTab.title}
          initialDescription={activeTab.description ?? ""}
          onSave={saveNew}
          onCancel={() => setSaveDialog(null)}
        />
      )}
      {datasetDialog && activeTab.connectionId !== null && (
        <SaveAsDatasetDialog
          connectionId={activeTab.connectionId}
          sql={activeTab.sql}
          initialName={activeTab.title.startsWith("Query ") ? "" : activeTab.title}
          onClose={() => setDatasetDialog(false)}
        />
      )}
    </div>
  );
}
