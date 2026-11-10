import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EmptyRange from "./EmptyRange.tsx";
import { clearTimeExtentCache } from "./extentCache.ts";
import { emptyRangeMessage, extentMessage, hasTimeRange } from "./emptyRange.ts";

describe("empty time range messages", () => {
  it("names the range that had no data", () => {
    expect(emptyRangeMessage("2026-10-01", "2026-11-09")).toBe("No data between Oct 1, 2026 and Nov 9, 2026.");
    expect(emptyRangeMessage("2026-10-01", null)).toBe("No data from Oct 1, 2026 on.");
    expect(emptyRangeMessage(null, "2026-11-09")).toBe("No data up to Nov 9, 2026.");
    expect(hasTimeRange(null, undefined)).toBe(false);
    expect(hasTimeRange("2026-10-01", null)).toBe(true);
  });

  it("says where the data actually is (timestamps are shown as days)", () => {
    expect(extentMessage({ column: "rental_date", min: "2005-05-24T22:53:30", max: "2006-02-14T15:16:03" })).toBe(
      "This dataset has data from May 24, 2005 to Feb 14, 2006.",
    );
    expect(extentMessage({ column: "d", min: "2025-01-01", max: "2025-01-01" })).toBe("This dataset only has data on Jan 1, 2025.");
    expect(extentMessage({ column: "d", min: null, max: null })).toBe("This dataset has no dates in this time column.");
  });
});

describe("EmptyRange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearTimeExtentCache();
  });

  function stubExtent(body: unknown, status = 200) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetches MIN/MAX of the chart's time column and offers 'Show all time'", async () => {
    const fetchMock = stubExtent({ column: "rental_date", min: "2005-05-24T22:53:30", max: "2006-02-14T15:16:03" });
    const onShowAllTime = vi.fn();
    render(<EmptyRange datasetId={3} column="rental_date" start="2026-10-01" end="2026-11-09" onShowAllTime={onShowAllTime} />);
    expect(screen.getByRole("status")).toHaveTextContent("No data between Oct 1, 2026 and Nov 9, 2026.");
    expect(await screen.findByTestId("time-extent")).toHaveTextContent("This dataset has data from May 24, 2005 to Feb 14, 2006.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/datasets/3/time-extent?column=rental_date");
    fireEvent.click(screen.getByRole("button", { name: "Show all time" }));
    expect(onShowAllTime).toHaveBeenCalledTimes(1);
  });

  it("uses the main time column by default, and has no button in dashboard tiles", async () => {
    const fetchMock = stubExtent({ column: "order_date", min: "2024-01-01", max: "2025-12-31" });
    render(<EmptyRange datasetId={4} column={null} start="2026-10-01" end={null} />);
    expect(await screen.findByTestId("time-extent")).toHaveTextContent("from Jan 1, 2024 to Dec 31, 2025");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/datasets/4/time-extent");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("still names the range when the extent can't be loaded", async () => {
    stubExtent({ detail: "boom" }, 500);
    render(<EmptyRange datasetId={4} column={null} start="2026-10-01" end="2026-11-09" />);
    await vi.waitFor(() => expect(document.querySelector(".empty-range-skeleton")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("No data between Oct 1, 2026 and Nov 9, 2026.");
    expect(screen.queryByTestId("time-extent")).not.toBeInTheDocument();
  });
});
