/** Read a design token (CSS variable) as the browser resolved it, e.g. cssVar("--accent").
 * For libraries that need real color strings (ECharts canvas, Monaco). */
export function cssVar(name: string, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

let probe: HTMLElement | null = null;

/** A token as it is on cards made of Paper (`.paper`): charts are always drawn on Paper, in
 * both themes, so ChartView and the ECharts theme read their colors here. */
export function paperVar(name: string): string {
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.className = "paper";
    probe.hidden = true;
    probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(probe);
  }
  return cssVar(name, probe);
}
