/**
 * Per-connection cache of schema metadata (schemas, tables, columns), used by the
 * schema tree and by autocomplete so they don't call the API on every keystroke.
 * Promises are cached, so concurrent callers share one request. Failed requests are
 * dropped from the cache so they can be retried.
 */
import { listColumns, listSchemas, listTables, type ColumnInfo, type TableInfo } from "../api.ts";

type Entry<T> = { promise: Promise<T>; value?: T };

type ConnectionCache = {
  schemas?: Entry<string[]>;
  tables: Map<string, Entry<TableInfo[]>>;
  columns: Map<string, Entry<ColumnInfo[]>>;
};

const caches = new Map<number, ConnectionCache>();

function cacheFor(connectionId: number): ConnectionCache {
  let cache = caches.get(connectionId);
  if (!cache) {
    cache = { tables: new Map(), columns: new Map() };
    caches.set(connectionId, cache);
  }
  return cache;
}

function cached<T>(
  get: () => Entry<T> | undefined,
  set: (entry: Entry<T> | undefined) => void,
  load: () => Promise<T>,
): Promise<T> {
  const existing = get();
  if (existing) return existing.promise;
  const entry: Entry<T> = { promise: load() };
  set(entry);
  entry.promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (get() === entry) set(undefined);
    },
  );
  return entry.promise;
}

const columnKey = (schema: string, table: string) => `${schema}\u0000${table}`;

export function getSchemas(connectionId: number): Promise<string[]> {
  const cache = cacheFor(connectionId);
  return cached(
    () => cache.schemas,
    (e) => {
      cache.schemas = e;
    },
    () => listSchemas(connectionId),
  );
}

export function getTables(connectionId: number, schema: string): Promise<TableInfo[]> {
  const cache = cacheFor(connectionId);
  return cached(
    () => cache.tables.get(schema),
    (e) => {
      if (e) cache.tables.set(schema, e);
      else cache.tables.delete(schema);
    },
    () => listTables(connectionId, schema),
  );
}

export function getColumns(connectionId: number, schema: string, table: string): Promise<ColumnInfo[]> {
  const cache = cacheFor(connectionId);
  const key = columnKey(schema, table);
  return cached(
    () => cache.columns.get(key),
    (e) => {
      if (e) cache.columns.set(key, e);
      else cache.columns.delete(key);
    },
    () => listColumns(connectionId, schema, table),
  );
}

/** Already-loaded tables per schema (never triggers a request). */
export function peekAllTables(connectionId: number): Map<string, TableInfo[]> {
  const result = new Map<string, TableInfo[]>();
  for (const [schema, entry] of caches.get(connectionId)?.tables ?? []) {
    if (entry.value) result.set(schema, entry.value);
  }
  return result;
}

export function clearConnectionCache(connectionId: number): void {
  caches.delete(connectionId);
}

/** For tests. */
export function clearAllCaches(): void {
  caches.clear();
}
