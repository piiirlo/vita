import { CalendarSearch } from "lucide-react";
import { useEffect, useState } from "react";
import type { TimeExtent } from "../api.ts";
import { timeExtent } from "./extentCache.ts";
import { emptyRangeMessage, extentMessage } from "./emptyRange.ts";

type Props = {
  datasetId: number;
  /** The time column the chart filtered on (null: the dataset's main time column). */
  column: string | null;
  start: string | null | undefined;
  end: string | null | undefined;
  /** Clears the time range (chart editor). Dashboard tiles leave it out. */
  onShowAllTime?: () => void;
};

/** An empty chart that had a time range: say which range, and where the data actually is
 * (MIN / MAX of the time column, fetched only now, so normal loads cost nothing extra). */
export default function EmptyRange({ datasetId, column, start, end, onShowAllTime }: Props) {
  // null while loading, "failed" when the hint isn't available.
  const [extent, setExtent] = useState<TimeExtent | "failed" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExtent(null);
    timeExtent(datasetId, column)
      .then((value) => !cancelled && setExtent(value))
      .catch(() => !cancelled && setExtent("failed")); // just no hint
    return () => {
      cancelled = true;
    };
  }, [datasetId, column]);

  return (
    <div className="chart-empty empty-range" role="status">
      <CalendarSearch size={20} aria-hidden className="empty-range-icon" />
      <p className="empty-range-text">
        <span>{emptyRangeMessage(start, end)}</span>
        {extent === null ? (
          <span className="skeleton empty-range-skeleton" aria-hidden />
        ) : extent === "failed" ? null : (
          <span data-testid="time-extent"> {extentMessage(extent)}</span>
        )}
      </p>
      {onShowAllTime && (
        <button type="button" className="small" onClick={onShowAllTime}>
          Show all time
        </button>
      )}
    </div>
  );
}
