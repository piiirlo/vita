import { Check } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { gsap, motionOn } from "../motion/ignara.ts";
import { STEP_LABELS, type SetupStep } from "./draft.ts";

/** Ignara's stepper: a dot per step (done = ember with a check, current = a breathing ember
 * dot) joined by bars that fill as steps are done. The fills run in on the first paint
 * (0.9s expo.out, 0.12s apart after 0.2s), later moves take 0.6s; a new current dot pops. */
export default function WizardSteps({ steps, current }: { steps: SetupStep[]; current: SetupStep }) {
  const at = steps.indexOf(current);
  const ref = useRef<HTMLOListElement>(null);
  const last = useRef<number | null>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const first = last.current === null;
    const fills = [...list.querySelectorAll<HTMLElement>(".steps-fill")];
    fills.forEach((fill, i) => {
      const to = i < at ? 1 : 0;
      if (!motionOn()) return void gsap.set(fill, { scaleX: to });
      gsap.to(fill, {
        scaleX: to,
        duration: first ? 0.9 : 0.6,
        delay: first ? 0.2 + i * 0.12 : 0,
        ease: "expo.out",
      });
    });
    const dot = list.querySelector<HTMLElement>("li[aria-current] .steps-dot");
    if (dot && motionOn() && last.current !== at)
      gsap.fromTo(dot, { scale: 0.5 }, { scale: 1, duration: 0.6, ease: "back.out(3)", clearProps: "transform" });
    last.current = at;
  }, [at]);
  return (
    <ol className="wizard-steps" aria-label="Steps" ref={ref}>
      {steps.map((step, i) => (
        <li key={step} className={i === at ? "on" : i < at ? "done" : ""} aria-current={i === at ? "step" : undefined}>
          <span className="steps-dot" aria-hidden>
            {i < at && <Check size={13} strokeWidth={2.6} />}
          </span>
          {i < steps.length - 1 && (
            <span className="steps-bar" aria-hidden>
              <i className="steps-fill" style={{ transform: `scaleX(${i < at ? 1 : 0})` }} />
            </span>
          )}
          <small>
            {STEP_LABELS[step]}
            {i < at && <span className="sr-only"> (done)</span>}
          </small>
        </li>
      ))}
    </ol>
  );
}
