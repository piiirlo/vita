import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

/** A shimmering placeholder (instead of a spinner) while something loads. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("skeleton h-4", className)} {...props} />;
}

/** Several skeleton lines in a status region, so screen readers hear "Loading…". */
export function SkeletonLines({ lines = 3, label = "Loading…", className }: { lines?: number; label?: string; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-3", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={i === lines - 1 ? "w-2/3" : "w-full"} />
      ))}
    </div>
  );
}
