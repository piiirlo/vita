/** Query tabs: state, reducer and localStorage persistence. */

export type Tab = {
  id: string;
  title: string;
  connectionId: number | null;
  schema: string | null;
  sql: string;
  /** Set when the tab was opened from / saved as a saved query. */
  savedQueryId: number | null;
  /** SQL at the last save/open, to show an "unsaved changes" dot. */
  savedSql: string | null;
  description: string | null;
};

export type TabInput = Partial<Omit<Tab, "id">>;

export type TabsState = { tabs: Tab[]; activeId: string };

export type TabsAction =
  | { type: "add"; tab: Tab } // create it with createTab() so the caller knows its id
  | { type: "close"; id: string }
  | { type: "select"; id: string }
  | { type: "update"; id: string; patch: TabInput };

export const STORAGE_KEY = "vita.sqllab.tabs.v1";

let counter = 0;
function newId(): string {
  counter += 1;
  return `tab-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

function nextTitle(tabs: Tab[]): string {
  const used = new Set(tabs.map((t) => t.title));
  let n = 1;
  while (used.has(`Query ${n}`)) n += 1;
  return `Query ${n}`;
}

export function createTab(existing: Tab[], partial: TabInput = {}): Tab {
  return {
    id: newId(),
    title: partial.title ?? nextTitle(existing),
    connectionId: partial.connectionId ?? null,
    schema: partial.schema ?? null,
    sql: partial.sql ?? "",
    savedQueryId: partial.savedQueryId ?? null,
    savedSql: partial.savedSql ?? null,
    description: partial.description ?? null,
  };
}

export function initialTabs(): TabsState {
  const tab = createTab([]);
  return { tabs: [tab], activeId: tab.id };
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "add":
      return { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const first = tabs[0];
      if (!first) return initialTabs();
      if (state.activeId !== action.id) return { ...state, tabs };
      const neighbour = tabs[Math.min(index, tabs.length - 1)] ?? first;
      return { tabs, activeId: neighbour.id };
    }
    case "select":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeId: action.id } : state;
    case "update":
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, ...action.patch } : t)),
      };
  }
}

export function isDirty(tab: Tab): boolean {
  return tab.savedQueryId !== null && tab.sql !== tab.savedSql;
}

// ---------- persistence ----------

/** localStorage can be missing or throw (private mode, blocked storage). */
export function getStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.sql === "string" &&
    (v.connectionId === null || typeof v.connectionId === "number") &&
    (v.schema === null || typeof v.schema === "string")
  );
}

export function loadTabs(storage: Storage | null = getStorage()): TabsState {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return initialTabs();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return initialTabs();
    const { tabs, activeId } = parsed as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(tabs)) return initialTabs();
    const valid: Tab[] = tabs.filter(isTab).map((t) => ({
      id: t.id,
      title: t.title,
      connectionId: t.connectionId,
      schema: t.schema,
      sql: t.sql,
      savedQueryId: typeof t.savedQueryId === "number" ? t.savedQueryId : null,
      savedSql: typeof t.savedSql === "string" ? t.savedSql : null,
      description: typeof t.description === "string" ? t.description : null,
    }));
    const first = valid[0];
    if (!first) return initialTabs();
    const active = valid.find((t) => t.id === activeId) ?? first;
    return { tabs: valid, activeId: active.id };
  } catch {
    return initialTabs();
  }
}

export function saveTabs(state: TabsState, storage: Storage | null = getStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: tabs just won't survive a refresh.
  }
}

/** Small per-browser settings (row limit, editor height). */
export function loadSetting<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = getStorage()?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    getStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
