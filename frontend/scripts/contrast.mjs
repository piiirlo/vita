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
  ["danger text on card", "--danger", ["--bg", "--surface"], NORMAL],
  ["danger text on error box", "--danger", ["--bg", "--surface", "--danger-bg"], NORMAL],
  ["body text on error box", "--text", ["--bg", "--surface", "--danger-bg"], NORMAL],
  ["success text on card (DONE)", "--success", ["--bg", "--surface"], NORMAL],
  ["success text on live chip", "--success", ["--bg", "--success-bg"], NORMAL],
  ["body text on live chip", "--text", ["--bg", "--success-bg"], NORMAL],
  ["live chip label", "--text", ["--bg", "--success-bg"], NORMAL],
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
console.log(failed ? `\n${failed} pair(s) below the minimum.` : "\nAll pairs pass.");
process.exit(failed ? 1 : 0);
