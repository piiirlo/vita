/** The world map, lazy-loaded with its GeoJSON (only charts that are maps load either). */
import { TriangleAlert } from "lucide-react";
import { MapChart } from "echarts/charts";
import * as echarts from "echarts/core";
import { useEffect, useMemo, useState } from "react";
import type { ChartDataResult, Dataset } from "../../api.ts";
import EChart from "../EChart.tsx";
import { metricLabel, type ChartState } from "../model.ts";
import type { DrawContext } from "../options.ts";
import { WORLD_MAP, unmatchedNotice, worldMapOption, worldMatch } from "./worldMap.ts";

echarts.use([MapChart]);

let registered: Promise<void> | null = null;
/** Load and register the shapes once per page. */
function loadWorld(): Promise<void> {
  registered ??= import("./world.json").then((m) => {
    echarts.registerMap(WORLD_MAP, m.default as unknown as Parameters<typeof echarts.registerMap>[1]);
  });
  return registered;
}

export default function WorldMapView({
  state,
  result,
  dataset,
  drawColors,
  showHints,
}: {
  state: ChartState;
  result: ChartDataResult;
  dataset: Dataset | null;
  drawColors: Pick<DrawContext, "colors" | "labelColor" | "tokens">;
  showHints: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadWorld()
      .then(() => !cancelled && setReady(true))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);
  const match = useMemo(() => worldMatch(state, result, dataset), [state, result, dataset]);
  const option = useMemo(() => worldMapOption(state, match, dataset, drawColors), [state, match, dataset, drawColors]);
  const notice = showHints ? unmatchedNotice(match.unmatched) : null;
  const metric = state.query.metrics[0];

  if (failed) {
    return (
      <p className="alert alert-error" role="alert">
        <strong>Error:</strong> the world map couldn't be loaded.
      </p>
    );
  }
  return (
    <>
      {ready ? (
        <EChart option={option} label={`World map of ${metric ? metricLabel(metric, dataset) : ""}: ${match.values.size} countries`} />
      ) : (
        <div className="skeleton map-skeleton" role="status" aria-label="Loading the map" />
      )}
      {notice && (
        <p className="chart-notice" role="note" data-testid="map-unmatched">
          <TriangleAlert size={14} aria-hidden />
          <span>
            {notice} Give them value labels with the country's name on the dataset's column.
          </span>
        </p>
      )}
    </>
  );
}
