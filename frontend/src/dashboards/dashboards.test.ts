import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardTile } from "../api.ts";
import { addChartTile, applyGridItems, layoutKey, nextPosition, stackOrder, toGridItems } from "./layout.ts";
import { renderMarkdown } from "./markdown.ts";
import { CancelledError, RequestQueue } from "./queue.ts";

const chart = (id: string, x: number, y: number, w = 6, h = 8): DashboardTile => ({ id, type: "chart", chart_id: 1, x, y, w, h });

describe("layout", () => {
  it("puts a new tile next to the last row when it fits, else below", () => {
    expect(nextPosition([], 6)).toEqual({ x: 0, y: 0 });
    expect(nextPosition([chart("a", 0, 0)], 6)).toEqual({ x: 6, y: 0 });
    expect(nextPosition([chart("a", 0, 0), chart("b", 6, 0)], 6)).toEqual({ x: 0, y: 8 });
    expect(nextPosition([chart("a", 0, 0, 8)], 6)).toEqual({ x: 0, y: 8 });
    const added = addChartTile([chart("a", 0, 0)], 7).at(-1)!;
    expect(added).toMatchObject({ type: "chart", chart_id: 7, x: 6, y: 0, w: 6, h: 8 });
  });

  it("copies grid positions onto tiles and keeps the same array when nothing moved", () => {
    const tiles = [chart("a", 0, 0), chart("b", 6, 0)];
    expect(applyGridItems(tiles, toGridItems(tiles))).toBe(tiles);
    const moved = applyGridItems(tiles, [{ i: "b", x: 0, y: 8, w: 12, h: 4 }]);
    expect(moved[1]).toMatchObject({ id: "b", x: 0, y: 8, w: 12, h: 4 });
    expect(moved[0]).toBe(tiles[0]);
    expect(layoutKey(moved)).not.toBe(layoutKey(tiles));
    expect(layoutKey([...tiles].reverse())).toBe(layoutKey(tiles));
  });

  it("stacks tiles top to bottom, then left to right", () => {
    const tiles = [chart("c", 0, 8), chart("b", 6, 0), chart("a", 0, 0)];
    expect(stackOrder(tiles).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("markdown", () => {
  it("renders markdown and strips scripts, handlers and javascript: links", () => {
    const html = renderMarkdown(
      '# Sales\n\n**bold** <img src=x onerror="alert(1)"><script>alert(2)</script> [ok](https://example.com) [bad](javascript:alert(3))',
    );
    expect(html).toContain("<h1>Sales</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("RequestQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("runs at most `limit` tasks at once, visible ones first", async () => {
    const queue = new RequestQueue(2);
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const task = (name: string, visible: boolean) => {
      const gate = deferred();
      gates.set(name, gate);
      return queue.schedule(async () => {
        started.push(name);
        await gate.promise;
        return name;
      }, visible);
    };
    const hidden1 = task("hidden1", false);
    task("hidden2", false);
    task("visible1", true);
    const late = task("hidden3", false);
    task("visible2", true);
    late.setVisible(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["visible1", "hidden3"]);
    expect(queue.active).toBe(2);

    gates.get("visible1")!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["visible1", "hidden3", "visible2"]);

    hidden1.cancel();
    await expect(hidden1.promise).rejects.toBeInstanceOf(CancelledError);
    gates.get("hidden3")!.resolve();
    gates.get("visible2")!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["visible1", "hidden3", "visible2", "hidden2"]);
    expect(queue.pending).toBe(0);
  });

  it("passes on results and errors, and keeps going after a failure", async () => {
    const queue = new RequestQueue(1);
    const failing = queue.schedule(() => Promise.reject(new Error("boom")));
    const ok = queue.schedule(() => Promise.resolve(42));
    const failed = expect(failing.promise).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    await expect(ok.promise).resolves.toBe(42);
  });
});
