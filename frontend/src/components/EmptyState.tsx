import { Sparkles, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type Props = {
  title: string;
  /** One short, friendly line on what to do next. */
  children?: ReactNode;
  /** The one clear action: usually a primary button or link. */
  action?: ReactNode;
  icon?: LucideIcon;
};

/** The same empty / no-results message on every page. */
export default function EmptyState({ title, children, action, icon: Icon = Sparkles }: Props) {
  return (
    <div className="card empty">
      <div className="empty-mark" aria-hidden>
        <Icon size={22} strokeWidth={1.8} />
      </div>
      <p className="empty-title">{title}</p>
      {children && <div className="muted">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
