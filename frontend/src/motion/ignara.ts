/**
 * Motion (Part 16): Ignara's GSAP primitives with its exact settings (see
 * design/ignara-design.md, "Motion"). GSAP 3.15 core only, no plugins.
 *
 * Every animation runs only when motion is on: never with prefers-reduced-motion, and never
 * under Vitest (jsdom has no layout, and tests read the final DOM). Tweens always end where
 * the page would be without them (`clearProps`), so turning motion off changes nothing else.
 */
import { gsap } from "gsap";

const media = (query: string): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
const reducedQuery = media("(prefers-reduced-motion: reduce)");
const finePointerQuery = media("(hover: hover) and (pointer: fine)");

/** Whether animations run (not under tests, not with reduced motion). */
export function motionOn(): boolean {
  return import.meta.env.MODE !== "test" && !(reducedQuery?.matches ?? false);
}

/** A duration / delay / stagger in seconds, or 0 when motion is off (Ignara's `J`). */
export const t = (seconds: number) => (motionOn() ? seconds : 0);

/** Subscribe to the reduced-motion setting (for hooks). */
export function onReducedMotionChange(listener: () => void): () => void {
  reducedQuery?.addEventListener("change", listener);
  return () => reducedQuery?.removeEventListener("change", listener);
}
export const prefersReducedMotion = () => reducedQuery?.matches ?? false;
export const finePointer = () => finePointerQuery?.matches ?? false;

type Targets = Element | Element[] | NodeListOf<Element>;
const list = (targets: Targets): Element[] => (targets instanceof Element ? [targets] : [...targets]);

/** Cards (Ignara's `co`): rise 26px and fade in, 0.8s expo.out. */
export function revealCards(targets: Targets, { y = 26, stagger = 0.06, delay = 0 } = {}) {
  const els = list(targets);
  if (!els.length || !motionOn()) return;
  gsap.fromTo(
    els,
    { opacity: 0, y },
    { opacity: 1, y: 0, duration: 0.8, ease: "expo.out", stagger, delay, clearProps: "transform,opacity" },
  );
}

/** Rows (Ignara's `lo`): rise 12px (8 in tables) and fade in, 0.55s power3.out. */
export function revealRows(targets: Targets, { x = 0, y = 12, stagger = 0.04, delay = 0 } = {}) {
  const els = list(targets);
  if (!els.length || !motionOn()) return;
  gsap.fromTo(
    els,
    { opacity: 0, x, y },
    { opacity: 1, x: 0, y: 0, duration: 0.55, ease: "power3.out", stagger, delay, clearProps: "transform,opacity" },
  );
}

/** Tiles (Ignara's `uo`, KPI and product tiles): rise 40px tilted ±2.5° at 95%, then settle
 * with back.out(1.4), 0.85s. */
export function revealTiles(targets: Targets, { stagger = 0.07, delay = 0 } = {}) {
  const els = list(targets);
  if (!els.length || !motionOn()) return;
  gsap.fromTo(
    els,
    { opacity: 0, y: 40, rotation: (i: number) => (i % 2 ? 2.5 : -2.5), scale: 0.95 },
    { opacity: 1, y: 0, rotation: 0, scale: 1, duration: 0.85, ease: "back.out(1.4)", stagger, delay, clearProps: "transform,opacity" },
  );
}

/**
 * The same reveals for elements whose `transform` belongs to someone else (dashboard tiles:
 * react-grid-layout positions them with it). The tween drives CSS variables that the
 * individual `translate` / `rotate` / `scale` properties read (`.tile-enter` in App.css).
 */
export function revealGridItems(targets: Targets, kind: "card" | "tile", { stagger = 0.05, delay = 0 } = {}) {
  const els = list(targets);
  if (!els.length || !motionOn()) return;
  const tile = kind === "tile";
  gsap.fromTo(
    els,
    {
      "--enter-o": 0,
      "--enter-y": tile ? "40px" : "26px",
      "--enter-r": (i: number) => (tile ? (i % 2 ? "2.5deg" : "-2.5deg") : "0deg"),
      "--enter-s": tile ? 0.95 : 1,
    },
    {
      "--enter-o": 1,
      "--enter-y": "0px",
      "--enter-r": "0deg",
      "--enter-s": 1,
      duration: tile ? 0.85 : 0.8,
      ease: tile ? "back.out(1.4)" : "expo.out",
      stagger,
      delay,
      clearProps: "--enter-o,--enter-y,--enter-r,--enter-s",
    },
  );
}

/** A page title's letters rise into place (Ignara's `so`): 115% down and turned 6°, 0.85s
 * power4.out, 0.022s apart. `chars` are the title's letter spans (PageHeader renders them). */
export function revealTitle(chars: Targets, delay = 0) {
  const els = list(chars);
  if (!els.length || !motionOn()) return;
  gsap.fromTo(
    els,
    { yPercent: 115, rotation: 6 },
    { yPercent: 0, rotation: 0, duration: 0.85, ease: "power4.out", stagger: 0.022, delay, clearProps: "transform" },
  );
}

/** A press (Ignara's `go`): a wide button springs back from 97%, an icon from 70%. */
export function press(el: Element | null) {
  if (!el || !motionOn()) return;
  const target = el.querySelector("svg") ?? el;
  const wide = target === el && (el as HTMLElement).offsetWidth > 120;
  gsap.fromTo(
    target,
    { scale: wide ? 0.97 : 0.7 },
    { scale: 1, duration: wide ? 0.4 : 0.55, ease: wide ? "back.out(2)" : "back.out(3)", overwrite: true, clearProps: "transform" },
  );
}

/** Something new pops in (Ignara's `fo`): from 60%, 0.6s back.out(3), 0.05s apart. */
export function pop(targets: Targets, { from = 0.6, delay = 0, stagger = 0.05 } = {}) {
  const els = list(targets);
  if (!els.length || !motionOn()) return;
  gsap.fromTo(
    els,
    { scale: from, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.6, ease: "back.out(3)", delay, stagger, overwrite: "auto", clearProps: "transform,opacity" },
  );
}

/** A value that just changed bumps (Ignara's `po`): 4px up at 108%, back in 0.55s back.out(2.4). */
export function bump(el: Element | null) {
  if (!el || !motionOn()) return;
  gsap.fromTo(el, { y: -4, scale: 1.08 }, { y: 0, scale: 1, duration: 0.55, ease: "back.out(2.4)", overwrite: "auto", clearProps: "transform" });
}

/** "No" (Ignara's `_o`, a refused form): a short shake, 0.42s power2.out. */
export function shake(el: Element | null) {
  if (!el || !motionOn()) return;
  gsap.fromTo(el, { x: 0 }, { keyframes: { x: [0, -8, 7, -5, 3, 0] }, duration: 0.42, ease: "power2.out", clearProps: "transform" });
}

/** A number counting to `to` (Ignara's count-ups): 1.2s power3.out. Returns a stop function. */
export function countTo(from: number, to: number, onUpdate: (n: number) => void, { duration = 1.2, delay = 0 } = {}): () => void {
  if (!motionOn() || from === to) {
    onUpdate(to);
    return () => undefined;
  }
  const state = { v: from };
  const tween = gsap.to(state, {
    v: to,
    duration,
    delay,
    ease: "power3.out",
    onUpdate: () => onUpdate(state.v),
    onComplete: () => onUpdate(to),
  });
  return () => {
    tween.kill();
  };
}

/**
 * Magnetic buttons (Ignara's `vo`): a `.magnetic` element (and the primary button of a dialog)
 * leans toward the pointer, x 20% / y 28% of its offset from the center, 0.5s power3.out, and
 * springs back when the pointer leaves. Fine pointers only. One listener for the document.
 */
export function enableMagnetic(doc: Document = document): () => void {
  const movers = new WeakMap<Element, { x: (v: number) => void; y: (v: number) => void }>();
  let current: HTMLElement | null = null;
  const of = (el: HTMLElement) => {
    let m = movers.get(el);
    if (!m) {
      const qx = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3.out" });
      const qy = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3.out" });
      m = {
        x: (v: number) => {
          qx(v);
        },
        y: (v: number) => {
          qy(v);
        },
      };
      movers.set(el, m);
    }
    return m;
  };
  const release = () => {
    if (!current) return;
    const m = of(current);
    m.x(0);
    m.y(0);
    current = null;
  };
  const onMove = (e: PointerEvent) => {
    if (!motionOn() || !finePointer()) return;
    const el = (e.target as Element | null)?.closest?.<HTMLElement>(".magnetic, [role=dialog] button.primary, [role=alertdialog] button.primary");
    if (el !== current) release();
    if (!el || (el as HTMLButtonElement).disabled) return;
    current = el;
    const box = el.getBoundingClientRect();
    const m = of(el);
    m.x((e.clientX - box.left - box.width / 2) * 0.2);
    m.y((e.clientY - box.top - box.height / 2) * 0.28);
  };
  doc.addEventListener("pointermove", onMove, { passive: true });
  doc.addEventListener("pointerleave", release);
  return () => {
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerleave", release);
  };
}

type Edges = { l: number; r: number; t: number; b: number };
type PillState = { edges?: Edges; live?: Edges };
const pills = new WeakMap<HTMLElement, PillState>();

/**
 * The stretchy selection pill (Ignara's sidebar / segmented control): `pill` covers its
 * parent and is clipped to `target`. Moving, the leading edge goes first (0.36s power3.out),
 * the trailing edge follows (0.55s power3.inOut) and the other two edges glide (0.45s).
 */
export function slidePill(pill: HTMLElement | null, target: HTMLElement | null, { radius = 14, animate = true } = {}) {
  if (!pill) return;
  const parent = pill.parentElement;
  if (!parent || !target || !target.offsetWidth) {
    gsap.set(pill, { opacity: 0 });
    return;
  }
  const w = parent.offsetWidth;
  const h = parent.offsetHeight;
  const next: Edges = {
    l: target.offsetLeft,
    r: w - (target.offsetLeft + target.offsetWidth),
    t: target.offsetTop,
    b: h - (target.offsetTop + target.offsetHeight),
  };
  const clip = (e: Edges) => `inset(${e.t}px ${e.r}px ${e.b}px ${e.l}px round ${radius}px)`;
  const state = pills.get(pill) ?? {};
  pills.set(pill, state);
  const prev = state.edges;
  state.edges = next;
  if (!animate || !prev || !motionOn() || Number(gsap.getProperty(pill, "opacity")) === 0) {
    if (state.live) gsap.killTweensOf(state.live);
    state.live = { ...next };
    gsap.set(pill, { clipPath: clip(next), opacity: 1 });
    return;
  }
  const live = state.live ?? { ...prev };
  state.live = live;
  gsap.killTweensOf(live);
  const vertical = Math.abs(next.t - prev.t) > Math.abs(next.l - prev.l);
  const forward = vertical ? next.t > prev.t : next.l > prev.l;
  const [lead, trail]: [keyof Edges, keyof Edges] = vertical ? (forward ? ["b", "t"] : ["t", "b"]) : forward ? ["r", "l"] : ["l", "r"];
  const [c1, c2]: [keyof Edges, keyof Edges] = vertical ? ["l", "r"] : ["t", "b"];
  const draw = () => gsap.set(pill, { clipPath: clip(live) });
  gsap.to(live, { [lead]: next[lead], duration: 0.36, ease: "power3.out", onUpdate: draw });
  gsap.to(live, { [trail]: next[trail], duration: 0.55, ease: "power3.inOut", onUpdate: draw });
  gsap.to(live, { [c1]: next[c1], [c2]: next[c2], duration: 0.45, ease: "power3.inOut", onUpdate: draw });
}

/** The app's first paint (Ignara's intro timeline): the sidebar slides in, its items follow,
 * the pill pops, the page header drops in and the page rises. */
export function playIntro(root: HTMLElement) {
  if (!motionOn()) return;
  const side = root.querySelector(".side");
  const tl = gsap.timeline();
  if (side && !side.classList.contains("is-phone")) {
    tl.fromTo(side, { x: -60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.9, ease: "expo.out", clearProps: "transform,opacity" });
    const items = side.querySelectorAll(".side-head, .side-group, .side-item, .side-me");
    if (items.length)
      tl.fromTo(
      items,
      { opacity: 0, x: -12 },
      { opacity: 1, x: 0, duration: 0.5, ease: "power3.out", stagger: 0.025, clearProps: "transform,opacity" },
      0.15,
    );
    const pill = side.querySelector(".side-pill");
    if (pill)
      tl.fromTo(pill, { scale: 0.7 }, { scale: 1, duration: 0.6, ease: "back.out(2.2)", transformOrigin: "0% 50%", clearProps: "transform" }, 0.5);
  } else if (side) {
    tl.fromTo(side, { y: 90 }, { y: 0, duration: 0.7, ease: "expo.out", clearProps: "transform" }, 0.2);
  }
  const main = root.querySelector("main");
  if (main) {
    const head = main.querySelectorAll(".topbar > *, header > *");
    if (head.length)
      tl.fromTo(
      head,
      { opacity: 0, y: -10 },
      { opacity: 1, y: 0, duration: 0.55, ease: "power3.out", stagger: 0.04, clearProps: "transform,opacity" },
      0.1,
    );
    tl.fromTo(main, { y: 30 }, { y: 0, duration: 1, ease: "expo.out", clearProps: "transform" }, 0.05);
  }
}

/** Switch the theme with Ignara's circular reveal from `origin` (450ms). */
export function themeReveal(origin: Element | null, swap: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || !motionOn()) {
    swap();
    return;
  }
  const box = origin?.getBoundingClientRect();
  const x = box ? box.left + box.width / 2 : 40;
  const y = box ? box.top + box.height / 2 : window.innerHeight - 40;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  doc
    .startViewTransition(swap)
    .ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 450, easing: "cubic-bezier(.65,0,.35,1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => undefined);
}

export { gsap };
