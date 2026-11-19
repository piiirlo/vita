# Ignara design language, for Vita (Part 16, round 1)

Source: `C:\Projects\ignara-study\ignara-readable` (index.html, index-D00nK7kU.css, overview /
settings CSS, GSAP calls in index-*.js). **License note:** every file there says "© 2026 Hasib
(OVERSHOOT). All rights reserved. Licensed, not sold", and the preview has a "Buy this template" link.
Round 2 re-implements the *look* in Vita's own code (tokens, our components). It copies no
Ignara CSS or JS. Before shipping, make sure your license covers the design.

## Character
Charcoal and ember. The surfaces are soft, warm neutrals stacked in layers (bg → side → card → card-2/3).
Every outline is an **inset 1px hairline shadow**, never a `border`. There is one hot accent (an
ember gradient). Everything is rounded, and the type is Urbanist at medium weight. The app is
dense but airy (cards have 20-22px padding and gaps are 18px). Motion is springy but short.

## Tokens (exact)
| | Light (`:root`) | Dark (`[data-theme=dark]`) |
|---|---|---|
| `--bg` page | #e7e6e4 | #26282c |
| `--side` sidebar | #f2f1ef | #1f2124 |
| `--card` / `--card-2` / `--card-3` | #f7f6f4 / #efeeeb / #e3e1de | #2f3135 / #36383d / #3f4147 |
| `--panel` (modal, drawer, menu) | #faf9f7 | #323439 |
| `--well` (inset fill) | #1414180d | #ffffff0a |
| `--ink` / `--ink-2` / `--muted` | #1d1e21 / #3a3b40 / #65666c | #f3f1ed / #d4d2ce / #a4a4a9 |
| `--line` / `--line-2` (hairlines) | #14141814 / #14141826 | #ffffff0f / #ffffff1f |
| `--top-light` (card top highlight) | #ffffffb3 | #ffffff0d |
| `--accent` / `--accent-hi` | #ee5230 / #f4633c | #f0552f / #f66a40 |
| `--accent-from` → `--accent-to` | #ff7b3a → #de3424 | #ff7c3c → #e2372a |
| `--accent-ink` (text on accent) | #1f0a04 | #1f0a04 |
| `--accent-text` / `--accent-soft` / `--accent-glow` | #b5361b / #ee523024 / #e43c2473 | #ff8c62 / #f0552f2b / #f046286b |
| `--thumb` / `--on-thumb` (selected segment, "New" button) | #1d1e21 / #f7f6f4 | #f3f1ed / #26282c |
| `--good` / `--warn` / `--bad` / `--info` | #1d7446 / #8a5807 / #b3222f / #2a5c99 | #74d6a0 / #f4c46e / #ff8a92 / #94bcf2 |
| `*-soft` (pill fills) | good #1e825021, warn #d7961e2e, bad #cd283c1c, info #2a5c991f | good #74d6a021, warn #f4c46e24, bad #ff8a9221, info #94bcf221 |
| chart `--c1..c6` | #ee5230 #e9952e #5d6168 #4f8fd1 #c39a66 #2f9c80 | #f0552f #f0a040 #a6a9b0 #6fa6e3 #d8b48a #4fbf9f |
| `--data` / `--data-2` (quiet series, grid) | #9a9ca2 / #c9cacd | #707379 / #55585e |
| heat `--h0..h6` (light) | #e2e1de #f6b49a #cfd2d8 #f2c98c #dcc7b8 #f19f86 #dad5cd | (same family; derive) |

- `--grad: linear-gradient(140deg, from, accent 50%, to)`, with `--on-grad: #fff` for big text only.
- **Shadows.** Light: `--shadow-sm 0 1px 2px #1e18140f`, `--shadow 0 1px 2px #1e18140d, 0 16px 34px -22px #1e181452`, `--shadow-lg 0 2px 6px #1e181414, 0 30px 60px -24px #1e181466`.
  Dark: `0 1px 2px #0000004d`, `0 1px 1px #00000040, 0 22px 40px -22px #000000bf`, `0 2px 6px #0006, 0 34px 70px -24px #000000e6`.
- **Card recipe:** `background: var(--card); box-shadow: inset 0 1px 0 var(--top-light), inset 0 0 0 1px var(--line), var(--shadow)`.
  Panels use `--panel` with `inset 0 0 0 1px var(--line), var(--shadow-lg)`.
- **Radii:** `--r-sm 10`, `--r-md 14`, `--r-lg 20` (cards), `--r-xl 26` (modal, drawer). Buttons and inputs are 12-13px, small buttons 10px, menus 16px, toasts 15px, nav items 14px, kbd 7px, pills 99px.
- **Type:** Urbanist variable 400-700, body `500 14px/1.45`, `tabular-nums` everywhere. Scale: 11 / 12 / 12.5 / 13.5 / 14 / 15 / 17 / 20 / 22 / 26 / 34.
  Page h1 is `clamp(28px, 2.6vw, 38px)`, weight 600, `-0.025em`, line-height 1.04. Card titles are 15/600. Labels and eyebrows are 12/600 muted. Group labels are 11/700 uppercase with `.08em` tracking.
  **There is no monospace font.**
- **Layout:** `--gap 18px` (12 on phones), `--pad 28px`, `--max 1560px`, sidebar `--side-w 248px`, rail `84px`.
- **Focus:** `outline 2px solid var(--ink)`, offset 2px. Inputs on focus: `inset 0 0 0 1.5px accent, 0 0 0 4px accent-soft`.

## Motion
Everything is driven by JS (GSAP); the CSS has **no transitions**. Reduced motion sets every duration to 0.001ms.
Base ease `--ease: cubic-bezier(.22,1,.36,1)`.

| What | How |
|---|---|
| Lists and cards entering | `y 8 → 0`, fade, 0.45s `power3.out`, stagger 0.04s (0.015-0.07 elsewhere), delay 0.08s |
| Modal / palette in | backdrop fade 0.25s; panel `y -18, scale .97 → 1`, 0.45s `back.out(1.6)` |
| Modal / palette out | `y -10, scale .97`, fade, 0.18s `power2.in` |
| Sidebar fold to rail | clip-path 0.32s `power3.inOut`, then content x-slide 0.6s `expo.out`, labels stagger 0.015s |
| Active nav / tab / segment | a sliding pill, line or thumb (FLIP), about 0.5-0.6s `expo.out` |
| Numbers, rings, bars | count up and draw in about 0.8-1.4s `expo.out` (ring delay 0.6s) |
| Live dot | `breathe` opacity pulse, 2s, infinite |

**In Vita (CSS-first, no GSAP):** `--ease-out: cubic-bezier(.16,1,.3,1)` (expo.out), `--ease-std: cubic-bezier(.22,1,.36,1)`,
`--ease-back: cubic-bezier(.34,1.56,.64,1)`, `--ease-in: cubic-bezier(.55,.06,.68,.19)`. Durations: 180 / 250 / 450 / 600ms.
The sliding indicators use CSS transitions on `transform` and `width`, measured once. CountUp stays (Motion, lazy).

## Shell
- **Sidebar (≥1280px):** fixed, 248px, `--side`, with an inset right hairline. It contains:
  - The brand mark: a 38px rounded tile with the gradient and glow, plus "Vita" 21/700.
  - A fold button that switches to the 84px rail.
  - A dark **"New" button**: `--thumb`, 46px, radius 15, with a kbd hint.
  - Uppercase group labels, and nav items (44px, radius 14, 600). The **active item has the gradient pill** with accent-ink text and glow.
  - Counts as small badges.
  - A footer group, and a bottom "today" card (Ignara's goal ring).
- **761-1279px:** the sidebar becomes an icon rail, with dots in place of counts.
- **≤760px:** a floating bottom tab bar (10px inset, radius 24, 5 items, gradient pill).
- **Top bar:** sticky, on `--bg`. It has a 44px search capsule (radius 14, kbd ⌘K), the date, 42px icon buttons (radius 13) and a "me" chip (avatar + name, 46px).
- **Page header (`phead`):** big h1, a muted line (≤70ch), and actions on the right.

## Components
- **Buttons:** 40px tall, radius 13, 600 weight, `--card` with a line-2 hairline. Variants:
  - `primary`: accent fill, accent-ink text, `inset 0 -2px 0 #00000014, 0 8px 18px -12px glow`.
  - `dark`: ink on bg.
  - `ghost`: no fill.
  - `danger`: bad-colored text.
  - Sizes: `sm` 32 / radius 10, `lg` 52 / radius 15.
  - Disabled is opacity .45.
- **Icon button:** 42px (`sm` 34px) on `--card`.
- **Inputs and selects:** 42px, radius 12, `--card-2` with a line-2 hairline. The select chevron is drawn with two gradients, and a textarea is 96px min. Field labels are 12.5/600 ink-2; hints are muted, errors bad.
- **Switch and checkbox:** the switch is 42×24 and turns accent when on. The checkbox is 20px, radius 6, accent fill with accent-ink check.
- **Segmented control:** a `--card-2` track with a sliding **ink thumb**. Tabs are 42px with an accent 2px sliding underline.
- **Tables:** th 12/600 muted; td 13.5/600, padding 11×14, line separators. Clickable rows get a `--card-2` hover with rounded ends.
- **Pills and badges:** pills are 24px, radius 99, a soft tone fill with a 6px dot. Badges are 20px. Chips are 32px, radius 10.
- **Modal and drawer:** modal radius 26, 520px wide (760 for `wide`); head 20/700, foot right-aligned. The drawer sits 10px inset on the right, 480px. Scrim: light #32180e42, dark #00000080.
- **Menus and popovers:** `--panel`, radius 16, padding 6. Items are 38px, radius 10, hover `--card-3`. Uppercase labels and 1px separators. Danger items are bad-colored.
- **Toasts:** bottom center, **inverted** (ink background, bg text), radius 15, with a colored icon and the action as a translucent button.
- **Empty states:** centered, with a 52px icon tile (radius 16, `--card-2`), a 15/600 title and a muted line (≤36ch).
- **Loading:** no spinners. Ignara has no skeleton class, so we keep our skeleton but in `--card-2` → `--card-3` with a calm shimmer.
- **KPI tiles:** 128px min, 22/600 value, 12.5 muted label, and a delta pill. The **"ember" hero tile** uses the gradient with white text at 34px.

## Ignara screen → Vita screen
| Ignara | Vita |
|---|---|
| Overview: KPI row + main chart + side column (`1fr 340px`) | Dashboard view (tiles = cards; the big number = KPI tile, optional ember hero) and Project page |
| Sales and takings charts | Chart cards, ECharts themed with c1..c6, `--data`, hairline grid |
| Orders, products and customers tables (+ drawer details) | Datasets / Charts / Dashboards / Connections lists, query history, results grid |
| Settings (`300px + 1fr`, row-set switches, formgrid) | Connection form, dataset Columns tab, account and password dialog |
| Finder (⌘K) | Command palette |
| Events (calendar) / wallet / bonus / help | No equivalent (not ported) |

## What Vita has and Ignara doesn't, in the same language
- **SQL Lab:** the editor sits in a `card--flush` with a toolbar row of `btn--sm` and a primary Run with a kbd hint.
  Monaco uses bg `--card`, line highlight `--well`, selection `--accent-soft`, keywords `--accent-text`, strings `--good`, numbers `--info`, comments `--muted`.
  Results use the table style with sticky th on `--card`. Keep **JetBrains Mono for SQL and result cells only**, since Ignara has no mono.
- **Chart editor:** a sticky `--side`-toned side panel with Data / Customize as accent-underline tabs. Sections are cards with 15/600 heads. The column palette uses chips, the type gallery uses selectable cards (selected = accent ring + soft fill), and the preview is a card.
- **Dashboard edit mode:** a dashed `--line-2` grid ghost, and the placeholder in `--accent-soft` with an accent hairline. Resize handles are 8px ink dots, and the edit toolbar is a floating panel.
- **Filter bar:** a row of chips (the filter name with its value in ink), popovers as `.pop` panels. Cross-filter chips use `tone--accent` with ×, and Reset is a ghost button.
- **Project folders (Home):** cards with a 48px colored monogram tile (Ignara's `.mono` color-mix), counts as badges, and the hover lift. "New project" is the dark `--thumb` button.
- **Setup wizard:** Ignara's `.steps` (numbered dots on a line-2 bar, accent for done and current) above a single centered card (760px max), with the footer actions right-aligned.
- **Schema diagram:** table cards in `--card` with hairlines, PK / FK as pills, edges in `--data`, and the focused path in accent.
- **Upload preview:** the table style. Bad cells get a `--warn-soft` fill with a dashed warn outline, and the adjust panel is the drawer.
- **Pivot / heatmap scales:** Vita's 5 heat levels become an ember ramp built from `--accent-soft` up to `--accent` (light) and the same in dark, keeping `--ink` at 4.5:1.

## Contrast (Vita's check:contrast)
- **Passing:** muted/bg 4.59 (light) and 5.95 (dark); accent-text/card 5.54 / 5.70; accent-ink/accent 5.33 / 5.48; good, warn and bad on card are all above 5.3.
- **Will need small nudges:** muted on `--card-3` is 4.38 (light) and 4.11 (dark). Darken light muted to about #5f6066 and lighten dark muted to about #aeaeb3.
- White on accent is 3.57, so the ember hero uses big text only (≥24px).
- The accent as a UI part on card is 3.30 / 3.75, which is fine at 3:1.
- Chart series: Ignara has 6. Vita needs 10, each with CIEDE2000 ≥15, so I'll add 4 in the same family (plum, olive, slate blue, sand) and run the check.
