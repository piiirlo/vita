import type { EChartsOption } from "echarts";
import { describe, expect, it } from "vitest";
import { ignaraStyle, withAlpha } from "./ignaraStyle.ts";

type S = Record<string, unknown>;
const series = (o: EChartsOption) => (o as { series: S[] }).series;

describe("ignaraStyle", () => {
  it("draws lines smooth, with a fading gradient under an area and a ringed hover dot", () => {
    const out = ignaraStyle(
      { series: [{ type: "line", data: [1, 2], areaStyle: { opacity: 0.22 }, itemStyle: { color: "#ee5230" }, lineStyle: { color: "#ee5230" } }] },
      { surface: "#f7f6f4" },
      true,
    );
    const line = series(out)[0]!;
    expect(line.smooth).toBe(0.35);
    expect(line.lineStyle).toMatchObject({ width: 2.4, cap: "round", color: "#ee5230" });
    expect(line.areaStyle).toMatchObject({ color: { colorStops: [{ color: "rgba(238, 82, 48, 0.26)" }, { color: "rgba(238, 82, 48, 0)" }] } });
    expect(line.emphasis).toMatchObject({ itemStyle: { color: "#f7f6f4", borderColor: "#ee5230", borderWidth: 2.5 } });
    expect(line).toMatchObject({ animationDuration: 1200, animationEasing: "cubicInOut" });
  });

  it("rounds bar tops, staggers them in, and keeps their own styles", () => {
    const out = ignaraStyle(
      { xAxis: { type: "category" }, yAxis: { type: "value" }, series: [{ type: "bar", data: [1, 2, 3, 4], itemStyle: { color: "#9a9ca2", borderType: "dashed" } }] },
      {},
      true,
    );
    const bar = series(out)[0]!;
    expect(bar.itemStyle).toMatchObject({ borderRadius: [8, 8, 3, 3], color: "#9a9ca2", borderType: "dashed" });
    const delay = bar.animationDelay as (i: number) => number;
    expect([delay(0), delay(2)]).toEqual([200, 450]);
  });

  it("horizontal bars are Ignara's rails (10px, on a track); stacked bars stay square", () => {
    const out = ignaraStyle(
      { yAxis: { type: "category" }, xAxis: { type: "value" }, series: [{ type: "bar", data: [1] }, { type: "bar", stack: "a", data: [1] }] },
      {},
      true,
    );
    expect(series(out)[0]).toMatchObject({ barWidth: 10, showBackground: true, itemStyle: { borderRadius: 10 } });
    expect(series(out)[1]!.itemStyle).toBeUndefined();
  });

  it("adds no timings when motion is off", () => {
    const out = ignaraStyle({ series: [{ type: "bar", data: [1] }] }, {}, false);
    expect(series(out)[0]).not.toHaveProperty("animationDuration");
    expect(series(out)[0]).not.toHaveProperty("animationDelay");
  });

  it("draws one series of bars as lollipops: stems, beads (ember at or over the target), a target line", () => {
    const t = { data: "#888888", accent: "#ee5230", accentFrom: "#ff7b3a", accentTo: "#e5432c", surface3: "#e3e1de", text: "#1d1e21" };
    const out = ignaraStyle({ xAxis: { type: "category" }, yAxis: { type: "value" }, series: [{ type: "bar", name: "Revenue", data: [10, 30, 20] }] }, t, false, {
      lollipop: { target: 25, latest: true },
    });
    const [stems, beads] = series(out);
    expect(stems).toMatchObject({ type: "bar", barWidth: 6, markLine: { data: [{ yAxis: 25 }] } });
    expect(beads).toMatchObject({ type: "scatter", name: "Revenue", symbolSize: 14 });
    const items = beads!.data as { itemStyle: { color: string; borderColor: string } }[];
    expect(items[0]!.itemStyle).toMatchObject({ color: "#e3e1de", borderColor: "#888888" }); // under the target
    expect(items[1]!.itemStyle).toMatchObject({ color: "#ff7b3a" }); // over it: ember
    expect(items[2]!.itemStyle).toMatchObject({ color: "#1d1e21" }); // the latest period: ink
  });

  it("turns a gauge into the dial: 44 ticks, the lit share in ember, the target as one ink tick", () => {
    const out = ignaraStyle(
      { series: [{ type: "gauge", min: 0, max: 100, data: [{ value: 50, name: "Revenue" }] }, { type: "gauge", data: [{ value: 80 }] }] },
      { surface3: "#e3e1de", accentFrom: "#ff7b3a", accentTo: "#e5432c" },
      false,
      { dial: true },
    );
    const [track, lit, marker] = series(out) as { splitNumber: number; startAngle: number; endAngle: number }[];
    expect(track!.splitNumber).toBe(43);
    expect(track!.endAngle).toBe(-45);
    expect(lit!.splitNumber).toBe(21); // 22 of 44 ticks lit
    expect(marker!.startAngle).toBeCloseTo(225 - 270 * 0.8); // the target at 80 of 100
  });

  it("makes rgba from hex, leaves other colors", () => {
    expect(withAlpha("#000000", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    expect(withAlpha("var(--x)", 0.5)).toBe("var(--x)");
  });
});
