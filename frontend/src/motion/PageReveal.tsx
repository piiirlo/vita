import { useLayoutEffect, useRef, type ReactNode } from "react";
import { motionOn, pop, revealCards, revealGridItems, revealRows, revealTiles } from "./ignara.ts";

// What enters, and how (Ignara's page hooks: overview / sales / customers / products).
const ROWS = "tr.stagger-item"; // table rows: 8px, 0.02s apart, after 0.3s
const TILES = ".folder, .dash-card"; // tiles: tilted rise, 0.07s apart
const GRID = ".tile-enter"; // dashboard tiles (react-grid-layout owns their transform)
const CARDS = ".stagger-item:not(tr), .card"; // cards: 26px, 0.05s apart, after 0.12s
const POPS = ".pop-in"; // chips and badges that appear: pop from 60%
const ALL = [ROWS, TILES, GRID, CARDS, POPS].join(", ");
/** Plain cards only enter with the page itself, not when one shows up later. */
const CARD_WINDOW_MS = 800;

/**
 * Wraps a page: elements that mount inside it (now or when their data arrives) enter the way
 * Ignara's do. Each element animates once, when it is added (a refresh keeps the elements, so
 * it never replays). Runs in a MutationObserver callback, before the browser paints, so
 * nothing flashes in its final place first. Off under reduced motion and tests.
 */
export function PageReveal({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !motionOn()) return;
    const start = performance.now();
    const seen = new WeakSet<Element>();

    const run = (added: Element[]) => {
      const found = new Set<Element>();
      for (const el of added) {
        if (el.matches(ALL)) found.add(el);
        el.querySelectorAll(ALL).forEach((child) => found.add(child));
      }
      const fresh = [...found].filter((el) => !seen.has(el));
      fresh.forEach((el) => seen.add(el));
      // Never animate inside something that is entering itself.
      const items = fresh.filter((el) => !fresh.some((other) => other !== el && other.contains(el)));
      if (!items.length) return;
      const elapsed = (performance.now() - start) / 1000;
      const after = (seconds: number) => Math.max(0, seconds - elapsed);

      const grid = items.filter((el) => el.matches(GRID));
      revealGridItems(
        grid.filter((el) => el.matches(".dash-tile-hero")),
        "tile",
        { stagger: 0.07, delay: after(0.12) },
      );
      revealGridItems(
        grid.filter((el) => !el.matches(".dash-tile-hero")),
        "card",
        { stagger: 0.05, delay: after(0.12) },
      );
      revealRows(
        items.filter((el) => el.matches(ROWS)),
        { y: 8, stagger: 0.02, delay: after(0.3) },
      );
      revealTiles(
        items.filter((el) => el.matches(TILES)),
        { stagger: 0.07, delay: after(0) },
      );
      pop(items.filter((el) => el.matches(POPS)));
      const cards = items.filter((el) => el.matches(CARDS) && !el.matches(ROWS) && !el.matches(GRID) && !el.matches(TILES) && !el.matches(POPS));
      revealCards(
        cards.filter((el) => el.matches(".stagger-item") || elapsed * 1000 < CARD_WINDOW_MS),
        { stagger: 0.05, delay: after(0.12) },
      );
    };

    run([root]);
    const observer = new MutationObserver((records) => {
      const added: Element[] = [];
      for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && added.push(n));
      if (added.length) run(added);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
