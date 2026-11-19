/** Monaco themes from the design tokens: the editor sits on the card of the current theme
 * (--code-bg), keywords in ember, strings green, numbers blue, muted line numbers. */
import { cssVar } from "../lib/cssVar.ts";
import type { ResolvedTheme } from "../theme/theme.ts";

type MonacoLike = {
  editor: {
    defineTheme(name: string, data: unknown): void;
    setTheme(name: string): void;
  };
};

/** Monaco wants #rrggbb / #rrggbbaa; tokens may be rgba(). */
export function toHex(color: string): string {
  const c = color.trim();
  if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + [...c.slice(1)].map((x) => x + x).join("");
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return c;
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(c);
  if (!m) return "#000000";
  const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  let alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (Number.isNaN(alpha)) alpha = 1;
  return `#${hex(+m[1]!)}${hex(+m[2]!)}${hex(+m[3]!)}${alpha < 1 ? hex(alpha * 255) : ""}`;
}

export const monacoThemeName = (mode: ResolvedTheme) => `vita-${mode}`;

/** (Re)define the theme for the current mode from the live CSS variables; returns its name. */
export function defineVitaMonacoTheme(monaco: MonacoLike, mode: ResolvedTheme): string {
  const v = (name: string) => toHex(cssVar(name));
  const noHash = (name: string) => v(name).slice(1);
  const name = monacoThemeName(mode);
  monaco.editor.defineTheme(name, {
    base: mode === "dark" ? "vs-dark" : "vs",
    inherit: true,
    // The ".sql" variants are needed: vs / vs-dark have their own (more specific) SQL rules.
    rules: [
      ["", "--code-text"],
      ["keyword", "--code-keyword"],
      ["keyword.sql", "--code-keyword"],
      ["operator", "--code-keyword"],
      ["operator.sql", "--code-keyword"],
      ["predefined", "--code-function"],
      ["predefined.sql", "--code-function"],
      ["string", "--code-string"],
      ["string.sql", "--code-string"],
      ["number", "--code-number"],
      ["number.sql", "--code-number"],
      ["delimiter", "--code-text"],
      ["delimiter.sql", "--code-text"],
      ["delimiter.parenthesis", "--code-text"],
      ["delimiter.parenthesis.sql", "--code-text"],
      ["identifier", "--code-text"],
      ["identifier.sql", "--code-text"],
      ["identifier.quote.sql", "--code-text"],
    ]
      .map(([token, color]) => ({ token, foreground: noHash(color!) }))
      .concat([
        { token: "comment", foreground: noHash("--code-comment"), fontStyle: "italic" },
        { token: "comment.sql", foreground: noHash("--code-comment"), fontStyle: "italic" },
      ] as { token: string; foreground: string; fontStyle?: string }[]),
    colors: {
      "editor.background": v("--code-bg"),
      "editor.foreground": v("--code-text"),
      "editorLineNumber.foreground": v("--code-line-number"),
      "editorLineNumber.activeForeground": v("--code-text"),
      "editor.lineHighlightBackground": v("--code-line-active"),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": v("--code-selection"),
      "editorCursor.foreground": v("--accent"),
      "editorIndentGuide.background1": v("--border"),
      "editorWidget.background": v("--surface-raised"),
      "editorWidget.border": v("--border-strong"),
      "editorSuggestWidget.background": v("--surface-raised"),
      "editorSuggestWidget.border": v("--border-strong"),
      "editorSuggestWidget.foreground": v("--text"),
      "editorSuggestWidget.selectedBackground": v("--surface-3"),
      "editorSuggestWidget.selectedForeground": v("--text"),
      "editorSuggestWidget.highlightForeground": v("--accent-text"),
      "editorHoverWidget.background": v("--surface-raised"),
      "editorHoverWidget.border": v("--border-strong"),
      "editorError.foreground": v("--danger"),
      "scrollbarSlider.background": v("--border-strong"),
      "scrollbarSlider.hoverBackground": v("--border-hover"),
      "editorOverviewRuler.border": "#00000000",
      "editorGutter.background": v("--code-bg"),
    },
  });
  return name;
}
