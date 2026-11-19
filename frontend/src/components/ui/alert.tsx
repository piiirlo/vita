import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/** An error message. Ember is the accent, so errors never rely on color alone: they use the
 * danger color, an icon, and the word "Error". */
export function ErrorAlert({ children, className, title = "Error" }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-[14px] border-0 bg-danger-bg px-3.5 py-3 text-sm text-text shadow-[inset_0_0_0_1px_var(--danger-border)]",
        className,
      )}
    >
      <CircleAlert size={18} className="mt-px shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 whitespace-pre-wrap">
        <strong className="font-bold text-danger">{title}: </strong>
        {children}
      </div>
    </div>
  );
}

const tones = {
  success: { icon: CircleCheck, box: "bg-success-bg shadow-[inset_0_0_0_1px_var(--success-border)]", iconClass: "text-success" },
  info: { icon: Info, box: "bg-info-bg shadow-[inset_0_0_0_1px_var(--border)]", iconClass: "text-info" },
  warning: { icon: TriangleAlert, box: "bg-warning-bg shadow-[inset_0_0_0_1px_var(--warning-border)]", iconClass: "text-[var(--warning-text)]" },
} as const;

export function Notice({ tone = "info", children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  const t = tones[tone];
  const Icon = t.icon;
  return (
    <div role="status" className={cn("flex items-start gap-2.5 rounded-[14px] border-0 px-3.5 py-3 text-sm text-text", t.box, className)}>
      <Icon size={18} className={cn("mt-px shrink-0", t.iconClass)} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
