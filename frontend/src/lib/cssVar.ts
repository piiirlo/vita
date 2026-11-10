/** Read a design token (CSS variable) as the browser resolved it, e.g. cssVar("--accent").
 * For libraries that need real color strings (ECharts canvas, Monaco). */
export function cssVar(name: string, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}
