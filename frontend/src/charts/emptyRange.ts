import type { TimeExtent } from "../api.ts";
import { formatBucket } from "./format.ts";

const day = (iso: string) => formatBucket(iso, "day");

/** Did the query filter on a time range? (Then an empty result may just be the wrong range.) */
export const hasTimeRange = (start: string | null | undefined, end: string | null | undefined) => Boolean(start || end);

/** "No data between Jun 1, 2025 and Jun 30, 2025." (or open on one side). */
export function emptyRangeMessage(start: string | null | undefined, end: string | null | undefined): string {
  if (start && end) return `No data between ${day(start)} and ${day(end)}.`;
  if (start) return `No data from ${day(start)} on.`;
  if (end) return `No data up to ${day(end)}.`;
  return "No data";
}

/** "This dataset has data from Jan 3, 2024 to Dec 30, 2025." */
export function extentMessage(extent: TimeExtent): string {
  if (!extent.min || !extent.max) return "This dataset has no dates in this time column.";
  if (day(extent.min) === day(extent.max)) return `This dataset only has data on ${day(extent.min)}.`;
  return `This dataset has data from ${day(extent.min)} to ${day(extent.max)}.`;
}
