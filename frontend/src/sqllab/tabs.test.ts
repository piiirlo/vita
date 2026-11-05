import { describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  createTab,
  initialTabs,
  isDirty,
  loadTabs,
  saveTabs,
  tabsReducer,
  type TabsState,
} from "./tabs.ts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

const throwingStorage = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
} as unknown as Storage;

describe("tabs reducer", () => {
  it("adds, updates, selects and closes tabs", () => {
    let state = initialTabs();
    const first = state.tabs[0]!;
    const second = createTab(state.tabs, { sql: "SELECT 2" });
    expect(second.title).toBe("Query 2");

    state = tabsReducer(state, { type: "add", tab: second });
    expect(state.activeId).toBe(second.id);

    state = tabsReducer(state, { type: "update", id: first.id, patch: { sql: "SELECT 1" } });
    expect(state.tabs[0]!.sql).toBe("SELECT 1");

    state = tabsReducer(state, { type: "close", id: second.id });
    expect(state.tabs.map((t) => t.id)).toEqual([first.id]);
    expect(state.activeId).toBe(first.id);

    // Closing the last tab leaves one fresh, empty tab.
    state = tabsReducer(state, { type: "close", id: first.id });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.sql).toBe("");
  });

  it("marks a saved query tab dirty when its SQL changes", () => {
    const tab = createTab([], { sql: "SELECT 1", savedQueryId: 7, savedSql: "SELECT 1" });
    expect(isDirty(tab)).toBe(false);
    expect(isDirty({ ...tab, sql: "SELECT 2" })).toBe(true);
    expect(isDirty(createTab([], { sql: "x" }))).toBe(false); // never saved: no dot
  });
});

describe("tab persistence", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    const tab = createTab([], { sql: "SELECT 42", connectionId: 3, schema: "sales" });
    const state: TabsState = { tabs: [tab], activeId: tab.id };
    saveTabs(state, storage);
    expect(loadTabs(storage)).toEqual(state);
  });

  it("falls back to one fresh tab for missing or corrupt data", () => {
    expect(loadTabs(memoryStorage()).tabs).toHaveLength(1);
    expect(loadTabs(memoryStorage({ [STORAGE_KEY]: "{not json" })).tabs).toHaveLength(1);
    expect(loadTabs(memoryStorage({ [STORAGE_KEY]: '{"tabs": [{"id": 1}]}' })).tabs[0]!.sql).toBe("");
    expect(loadTabs(null).tabs).toHaveLength(1);
  });

  it("never throws when storage is blocked", () => {
    expect(() => saveTabs(initialTabs(), throwingStorage)).not.toThrow();
    expect(loadTabs(throwingStorage).tabs).toHaveLength(1);
  });
});
