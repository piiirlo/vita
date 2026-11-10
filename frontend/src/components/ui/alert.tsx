import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/** An error message. Orange is the accent, so errors never rely on color alone: they use the
 * danger color, an icon, and the word "Error". */
export function ErrorAlert({ children, className, title = "Error" }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-control border border-danger-border bg-danger-bg px-3.5 py-2.5 text-sm text-text",
        className,
      )}
    >
      <CircleAlert size={18} className="mt-px shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 whitespace-pre-wrap">
        <strong className="font-semibold text-danger">{title}: </strong>
        {children}
      </div>
    </div>
  );
}

const tones = {
  success: { icon: CircleCheck, box: "border-success-border bg-success-bg", iconClass: "text-success" },
  info: { icon: Info, box: "border-border-strong bg-surface", iconClass: "text-muted" },
  warning: { icon: TriangleAlert, box: "border-[var(--warning-border)] bg-[var(--warning-bg)]", iconClass: "text-[var(--warning-text)]" },
} as const;

export function Notice({ tone = "info", children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  const t = tones[tone];
  const Icon = t.icon;
  return (
    <div role="status" className={cn("flex items-start gap-2.5 rounded-control border px-3.5 py-2.5 text-sm text-text", t.box, className)}>
      <Icon size={18} className={cn("mt-px shrink-0", t.iconClass)} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
