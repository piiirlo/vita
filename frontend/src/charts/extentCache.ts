/** Where a dataset's data is in time (MIN / MAX of a time column), cached for a few minutes so
 * many charts on one dataset ask once. Used for incomplete periods and empty time ranges. */
import { useEffect, useState } from "react";
import { getTimeExtent, type TimeExtent } from "../api.ts";

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; promise: Promise<TimeExtent> }>();

export function timeExtent(datasetId: number, column: string | null): Promise<TimeExtent> {
  const key = `${datasetId}:${column ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = getTimeExtent(datasetId, column);
  promise.catch(() => cache.delete(key)); // don't keep failures
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** For tests. */
export function clearTimeExtentCache(): void {
  cache.clear();
}

/** The extent, or null while loading / when it isn't needed / when it fails. */
export function useTimeExtent(datasetId: number | null, column: string | null, enabled: boolean): TimeExtent | null {
  const [extent, setExtent] = useState<{ key: string; value: TimeExtent } | null>(null);
  const key = `${datasetId}:${column ?? ""}`;
  useEffect(() => {
    if (!enabled || datasetId === null) return;
    let cancelled = false;
    timeExtent(datasetId, column)
      .then((value) => !cancelled && setExtent({ key, value }))
      .catch(() => undefined); // incomplete periods just aren't marked
    return () => {
      cancelled = true;
    };
  }, [datasetId, column, enabled, key]);
  return enabled && extent?.key === key ? extent.value : null;
}
