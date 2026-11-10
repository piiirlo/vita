import type { ReactNode } from "react";

/** Wrap a page: it fades in and rises 12px when it opens (CSS `page-enter`, so the main
 * bundle doesn't need the Motion library; prefers-reduced-motion turns it off). */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`page-enter${className ? ` ${className}` : ""}`}>{children}</div>;
}
