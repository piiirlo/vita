/**
 * Motion rules (the Ignara look), see CLAUDE.md and motion/ignara.ts:
 * - GSAP with Ignara's exact settings; cards / rows / tiles enter through motion/PageReveal.
 * - Big numbers count up once, 1.2s power3.out (Ignara's count-ups).
 * - prefers-reduced-motion (and tests) turn all of it off.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInView } from "../dashboards/hooks.ts";
import { bump, countTo, motionOn } from "../motion/ignara.ts";
import { useReducedMotion } from "../motion/useReducedMotion.ts";

/**
 * A number that counts up from 0 the first time it is shown. Later changes (a refresh) just
 * show the new value. `format` turns the in-between numbers into text.
 */
export function CountUp({
  value,
  format,
  render = (text) => text,
  durationMs = 1200,
}: {
  value: number;
  format(n: number): string;
  /** Draw the formatted text (e.g. to color the decimals). */
  render?(text: string): ReactNode;
  durationMs?: number;
}) {
  const reduce = useReducedMotion() || !motionOn();
  const ref = useRef<HTMLSpanElement>(null);
  // Our own hook: treats "no IntersectionObserver" as visible instead of throwing.
  const inView = useInView(ref) === true;
  const played = useRef(false);
  const shownValue = useRef<number | null>(null);
  const [shown, setShown] = useState<number>(reduce ? value : 0);

  useEffect(() => {
    if (reduce || played.current) {
      // A new value after the first count (a refresh) bumps instead of counting again.
      if (played.current && shownValue.current !== value) bump(ref.current);
      shownValue.current = value;
      setShown(value);
      return;
    }
    if (!inView) return;
    played.current = true;
    shownValue.current = value;
    return countTo(0, value, setShown, { duration: durationMs / 1000 });
  }, [value, inView, reduce, durationMs]);

  return (
    <span ref={ref} className="inline-block">
      {/* The final value for screen readers and tests; the animated one is visual only. */}
      <span className="sr-only">{format(value)}</span>
      <span aria-hidden>{render(format(shown))}</span>
    </span>
  );
}
