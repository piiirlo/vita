import type { ReactNode } from "react";

type Props = {
  title: string;
  /** A hint on what to do next. */
  children?: ReactNode;
  /** Usually a primary button or link. */
  action?: ReactNode;
};

/** The same empty / no-results message on every list page. */
export default function EmptyState({ title, children, action }: Props) {
  return (
    <div className="card empty">
      <p className="empty-title">{title}</p>
      {children && <div className="muted small">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
