/**
 * Motion rules (Observatory), see CLAUDE.md:
 * - UI feedback 150-250 ms; page enter = fade + 12px rise (CSS .page-enter).
 * - Lists and dashboard tiles: 70 ms stagger on first mount only (CSS .stagger-item /
 *   .tile-enter with data-enter); a refresh keeps the elements, so it never replays.
 * - prefers-reduced-motion turns all of it off (CSS rule in styles/components.css; JS
 *   animations check useReducedMotion()).
 * The Motion library is only used where JS animation is needed (CountUp), which keeps it
 * out of the main bundle.
 */
import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInView } from "../dashboards/hooks.ts";

const EASE_OUT = [0.2, 0.7, 0.2, 1] as const;

/**
 * A number that counts up from 0 the first time it is shown. Later changes (a refresh) just
 * show the new value. `format` turns the in-between numbers into text.
 */
export function CountUp({
  value,
  format,
  render = (text) => text,
  durationMs = 900,
}: {
  value: number;
  format(n: number): string;
  /** Draw the formatted text (e.g. to color the decimals). */
  render?(text: string): ReactNode;
  durationMs?: number;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  // Our own hook: treats "no IntersectionObserver" as visible instead of throwing.
  const inView = useInView(ref) === true;
  const played = useRef(false);
  const [shown, setShown] = useState<number>(reduce ? value : 0);

  useEffect(() => {
    if (reduce || played.current) {
      setShown(value);
      return;
    }
    if (!inView) return;
    played.current = true;
    const controls = animate(0, value, {
      duration: durationMs / 1000,
      ease: EASE_OUT,
      onUpdate: (n) => setShown(n),
      onComplete: () => setShown(value),
    });
    return () => controls.stop();
  }, [value, inView, reduce, durationMs]);

  return (
    <span ref={ref}>
      {/* The final value for screen readers and tests; the animated one is visual only. */}
      <span className="sr-only">{format(value)}</span>
      <span aria-hidden>{render(format(shown))}</span>
    </span>
  );
}
