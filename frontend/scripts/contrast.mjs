// WCAG contrast audit of the design tokens (both themes).
//   node scripts/contrast.mjs        (from frontend/; exits 1 if a pair fails)
// Reads src/styles/tokens.css, resolves var() references, blends translucent colors over
// their real background, and checks every text/background pair the UI uses:
// 4.5:1 for normal text, 3:1 for large text (24px+, or 18.66px+ bold) and UI parts.
import fs from "node:fs";

const css = fs.readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function block(selector) {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const vars = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}
const light = block(":root");
const dark = { ...light, ...block('[data-theme="dark"]') };

function resolve(vars, value, depth = 0) {
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!m) return value.trim();
  if (depth > 10) throw new Error("var loop");
  return resolve(vars, vars[m[1]], depth + 1);
}

function parse(color) {
  const c = color.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]].map((x) => parseInt(x + x, 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  throw new Error(`can't parse color ${c}`);
}

const over = (top, bottom) => {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
};

function luminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const ratio = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

// [what, text token, background stack (bottom first), minimum]
const NORMAL = 4.5;
const LARGE = 3;
const UI = 3; // icons, borders and other non-text UI parts
const PAIRS = [
  ["body text on page", "--text", ["--bg"], NORMAL],
  ["body text on card", "--text", ["--bg", "--surface"], NORMAL],
  ["body text on raised (menus, toasts)", "--text", ["--bg", "--surface-raised"], NORMAL],
  ["body text on sunken", "--text", ["--bg", "--surface-sunken"], NORMAL],
  ["muted text on page", "--text-muted", ["--bg"], NORMAL],
  ["muted text on card", "--text-muted", ["--bg", "--surface"], NORMAL],
  ["muted text on raised", "--text-muted", ["--bg", "--surface-raised"], NORMAL],
  ["muted text on hovered row", "--text-muted", ["--bg", "--surface", "--selected"], NORMAL],
  ["muted text on rail", "--text-muted", ["--bg", "--rail-bg"], NORMAL],
  ["faint text (placeholders, NULL) on card", "--text-faint", ["--bg", "--surface"], NORMAL],
  ["faint text on page", "--text-faint", ["--bg"], NORMAL],
  ["body text on hovered row", "--text", ["--bg", "--surface", "--selected"], NORMAL],
  ["link on page", "--link", ["--bg"], NORMAL],
  ["link on card", "--link", ["--bg", "--surface"], NORMAL],
  ["link hover on card", "--link-hover", ["--bg", "--surface"], NORMAL],
  ["accent text on page", "--accent-text", ["--bg"], NORMAL],
  ["accent text on card", "--accent-text", ["--bg", "--surface"], NORMAL],
  ["accent text on raised", "--accent-text", ["--bg", "--surface-raised"], NORMAL],
  ["text on orange (primary button)", "--accent-fg", ["--accent"], NORMAL],
  ["active rail item / tooltip", "--inverse-fg", ["--inverse-bg"], NORMAL],
  ["hero: number on ink", "--ink-text", ["--surface-ink"], NORMAL],
  ["hero: labels on ink", "--ink-muted", ["--surface-ink"], NORMAL],
  ["hero: decimals (large) on ink", "--accent", ["--surface-ink"], LARGE],
  ["hero: below-target value / change on ink", "--ink-danger", ["--surface-ink"], NORMAL],
  ["hero: above-target value / change on ink", "--ink-success", ["--surface-ink"], NORMAL],
  ["big number: below-target value / change on card", "--danger", ["--bg", "--surface"], NORMAL],
  ["big number: above-target value / change on card", "--success", ["--bg", "--surface"], NORMAL],
  ["danger text on card", "--danger", ["--bg", "--surface"], NORMAL],
  ["danger text on error box", "--danger", ["--bg", "--surface", "--danger-bg"], NORMAL],
  ["body text on error box", "--text", ["--bg", "--surface", "--danger-bg"], NORMAL],
  ["success text on card (DONE)", "--success", ["--bg", "--surface"], NORMAL],
  ["success text on live chip", "--success", ["--bg", "--success-bg"], NORMAL],
  ["body text on live chip", "--text", ["--bg", "--success-bg"], NORMAL],
  ["live chip label", "--text", ["--bg", "--success-bg"], NORMAL],
  ["'Connected' text in success box", "--success", ["--bg", "--surface", "--success-bg"], NORMAL],
  ["'Connected' check circle on success box", "--success", ["--bg", "--surface", "--success-bg"], UI],
  ["'Connected' tick on check circle", "--surface", ["--success"], UI],
  ["warning text on warning box", "--warning-text", ["--bg", "--surface", "--warning-bg"], NORMAL],
  ["body text on metric chip", "--text", ["--bg", "--surface", "--accent-soft"], NORMAL],
  ["SQL text", "--code-text", ["--code-bg"], NORMAL],
  ["SQL keywords", "--code-keyword", ["--code-bg"], NORMAL],
  ["SQL functions", "--code-function", ["--code-bg"], NORMAL],
  ["SQL strings", "--code-string", ["--code-bg"], NORMAL],
  ["SQL numbers", "--code-number", ["--code-bg"], NORMAL],
  ["SQL comments", "--code-comment", ["--code-bg"], NORMAL],
  ["SQL line numbers", "--code-line-number", ["--code-bg"], NORMAL],
  ["SQL text on ink (dataset/chart SQL blocks)", "--code-text", ["--code-bg"], NORMAL],
  // UI parts (3:1): focus ring and the orange against the page.
  ["focus ring vs page", "--focus-ring", ["--bg"], LARGE],
  ["focus ring vs card", "--focus-ring", ["--bg", "--surface"], LARGE],
];

// Chart series: each one is a UI part (3:1 on cards), and every two must be clearly different
// colors (CIEDE2000; 15+ is "clearly different" at a glance, neighbors get 18+).
const SERIES = Array.from({ length: 10 }, (_, i) => `--series-${i + 1}`);
for (const token of SERIES) PAIRS.push([`chart ${token.slice(2)} on card`, token, ["--bg", "--surface"], UI]);
const MIN_DELTA_E = 15;
const MIN_DELTA_E_NEIGHBORS = 18;

function toLab([r, g, b]) {
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 color difference. */
function deltaE(c1, c2) {
  const [L1, a1, b1] = toLab(c1);
  const [L2, a2, b2] = toLab(c2);
  const rad = Math.PI / 180;
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (a, b) => (Math.atan2(b, a) / rad + 360) % 360;
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lm = (L1 + L2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0) hm = Math.abs(h1p - h2p) > 180 ? (hm + (hm < 360 ? 360 : -360)) / 2 : hm / 2;
  const T =
    1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cmp;
  const SH = 1 + 0.015 * Cmp * T;
  const RT = -2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

let failed = 0;
for (const [theme, vars] of [
  ["light", light],
  ["dark", dark],
]) {
  console.log(`\n${theme}`);
  for (const [what, fg, stack, min] of PAIRS) {
    let bg = parse(resolve(vars, vars[stack[0]]));
    for (const layer of stack.slice(1)) bg = over(parse(resolve(vars, vars[layer])), bg);
    const text = over(parse(resolve(vars, vars[fg])), bg);
    const r = ratio(text, bg);
    const ok = r >= min;
    if (!ok) failed += 1;
    console.log(`${ok ? "  ok  " : "  FAIL"} ${r.toFixed(2).padStart(5)}:1 (min ${min})  ${what}  [${fg}]`);
  }
}

for (const [theme, vars] of [
  ["light", light],
  ["dark", dark],
]) {
  console.log(`\n${theme}: chart series must be clearly different`);
  const colors = SERIES.map((t) => parse(resolve(vars, vars[t])));
  let worst = { d: Infinity, what: "" };
  for (let i = 0; i < colors.length; i++)
    for (let j = i + 1; j < colors.length; j++) {
      const d = deltaE(colors[i], colors[j]);
      const min = j === i + 1 ? MIN_DELTA_E_NEIGHBORS : MIN_DELTA_E;
      if (d < min) {
        failed += 1;
        console.log(`  FAIL ΔE ${d.toFixed(1)} (min ${min})  series-${i + 1} vs series-${j + 1}`);
      }
      if (d < worst.d) worst = { d, what: `series-${i + 1} vs series-${j + 1}` };
    }
  console.log(`  closest pair: ${worst.what}, ΔE ${worst.d.toFixed(1)} (min ${MIN_DELTA_E}, neighbors ${MIN_DELTA_E_NEIGHBORS})`);
}
console.log(failed ? `\n${failed} pair(s) below the minimum.` : "\nAll pairs pass.");
process.exit(failed ? 1 : 0);
