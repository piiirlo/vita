import { Check } from "lucide-react";
import { STEP_LABELS, type SetupStep } from "./draft.ts";

/** The numbered step pills: done ones get a check, the current one is Clay. */
export default function WizardSteps({ steps, current }: { steps: SetupStep[]; current: SetupStep }) {
  const at = steps.indexOf(current);
  return (
    <ol className="wizard-steps" aria-label="Steps">
      {steps.map((step, i) => (
        <li key={step} className={i === at ? "on" : i < at ? "done" : ""} aria-current={i === at ? "step" : undefined}>
          <span aria-hidden>{i < at ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
          {STEP_LABELS[step]}
          {i < at && <span className="sr-only"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}
