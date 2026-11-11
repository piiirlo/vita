import type { VizType } from "../api.ts";

/** Small static drawing of a chart type for the picker (theme colors via CSS classes:
 * .s1-.s3 fill with --series-N, .l1/.l2 stroke, .g grid lines; see App.css "chart picker"). */
export default function VizThumb({ viz }: { viz: VizType }) {
  return (
    <svg className="viz-thumb" viewBox="0 0 64 40" aria-hidden focusable="false">
      {SHAPES[viz]}
    </svg>
  );
}

const axis = <path className="g" d="M6 34H58" />;

const SHAPES: Record<VizType, React.ReactNode> = {
  line: (
    <>
      {axis}
      <path className="l1" d="M6 28 L16 22 L26 25 L36 14 L46 17 L58 8" />
      <path className="l2" d="M6 31 L16 29 L26 30 L36 25 L46 27 L58 22" />
    </>
  ),
  area: (
    <>
      {axis}
      <path className="s2 soft" d="M6 34 L6 26 L18 22 L30 24 L42 16 L58 12 L58 34 Z" />
      <path className="s1 soft" d="M6 34 L6 30 L18 28 L30 29 L42 24 L58 22 L58 34 Z" />
      <path className="l1" d="M6 30 L18 28 L30 29 L42 24 L58 22" />
    </>
  ),
  bar: (
    <>
      {axis}
      <rect className="s1" x="9" y="16" width="8" height="18" rx="1.5" />
      <rect className="s1" x="21" y="9" width="8" height="25" rx="1.5" />
      <rect className="s1" x="33" y="20" width="8" height="14" rx="1.5" />
      <rect className="s1" x="45" y="12" width="8" height="22" rx="1.5" />
    </>
  ),
  combo: (
    <>
      {axis}
      <rect className="s2" x="9" y="18" width="8" height="16" rx="1.5" />
      <rect className="s2" x="21" y="12" width="8" height="22" rx="1.5" />
      <rect className="s2" x="33" y="21" width="8" height="13" rx="1.5" />
      <rect className="s2" x="45" y="15" width="8" height="19" rx="1.5" />
      <path className="l1" d="M13 22 L25 10 L37 14 L49 6" />
    </>
  ),
  pie: (
    <>
      <circle className="s2" cx="32" cy="20" r="15" />
      <path className="s1" d="M32 20 L32 5 A15 15 0 0 1 46.3 24.6 Z" />
      <path className="s3" d="M32 20 L46.3 24.6 A15 15 0 0 1 36 34.5 Z" />
    </>
  ),
  treemap: (
    <>
      <rect className="s1" x="6" y="4" width="28" height="32" rx="2" />
      <rect className="s2" x="36" y="4" width="22" height="18" rx="2" />
      <rect className="s3" x="36" y="24" width="12" height="12" rx="2" />
      <rect className="s2 soft" x="50" y="24" width="8" height="12" rx="2" />
    </>
  ),
  funnel: (
    <>
      <rect className="s1" x="8" y="5" width="48" height="7" rx="1.5" />
      <rect className="s2" x="15" y="15" width="34" height="7" rx="1.5" />
      <rect className="s3" x="22" y="25" width="20" height="7" rx="1.5" />
    </>
  ),
  big_number: (
    <>
      <rect className="g-fill" x="10" y="9" width="30" height="12" rx="2" />
      <rect className="s1" x="42" y="9" width="12" height="12" rx="2" />
      <path className="l2" d="M10 31 L22 28 L34 30 L46 25 L54 26" />
    </>
  ),
  gauge: (
    <>
      <path className="track" d="M12 32 A20 20 0 0 1 52 32" />
      <path className="l1 thick" d="M12 32 A20 20 0 0 1 40 13.5" />
      <path className="needle" d="M32 32 L42 18" />
    </>
  ),
  table: (
    <>
      <rect className="g-fill" x="6" y="5" width="52" height="6" rx="1.5" />
      <path className="g" d="M6 17H58M6 23H58M6 29H58M6 35H58" />
      <rect className="s1" x="42" y="14" width="14" height="3" rx="1" />
      <rect className="s1" x="46" y="20" width="10" height="3" rx="1" />
      <rect className="s1" x="40" y="26" width="16" height="3" rx="1" />
    </>
  ),
  pivot_table: (
    <>
      <rect className="g-fill" x="6" y="5" width="52" height="6" rx="1.5" />
      <rect className="g-fill" x="6" y="13" width="12" height="22" rx="1.5" />
      <rect className="s1 h1" x="20" y="13" width="11" height="6" rx="1" />
      <rect className="s1 h3" x="33" y="13" width="11" height="6" rx="1" />
      <rect className="s1 h2" x="46" y="13" width="12" height="6" rx="1" />
      <rect className="s1 h3" x="20" y="21" width="11" height="6" rx="1" />
      <rect className="s1 h1" x="33" y="21" width="11" height="6" rx="1" />
      <rect className="s1 h4" x="46" y="21" width="12" height="6" rx="1" />
      <rect className="s1 h2" x="20" y="29" width="11" height="6" rx="1" />
      <rect className="s1 h4" x="33" y="29" width="11" height="6" rx="1" />
      <rect className="s1 h2" x="46" y="29" width="12" height="6" rx="1" />
    </>
  ),
};
