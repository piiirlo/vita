import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { openCommandPalette } from "./commandPaletteStore.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The frosted search capsule: opens the command palette (also Ctrl+K / Cmd+K). */
export function SearchCapsule({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label="Search and commands"
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      className={cn(
        "flex h-[46px] min-w-0 flex-[0_1_420px] cursor-pointer items-center gap-3 rounded-pill border border-border-strong",
        "bg-[var(--capsule-bg)] py-0 pl-4 pr-2 font-sans text-sm text-muted backdrop-blur-[14px]",
        "transition-[background-color,border-color] duration-200 hover:border-border-hover hover:bg-hover",
        className,
      )}
    >
      <Search size={18} strokeWidth={2} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">Jump to a chart, table or query…</span>
      <kbd className="rounded-pill border border-border-strong px-2 py-1 font-mono text-xs text-text">
        {isMac ? "⌘ K" : "Ctrl K"}
      </kbd>
    </button>
  );
}

type Props = {
  title: ReactNode;
  /** Small mono uppercase line above the title, e.g. "SPACES / SALES". */
  eyebrow?: ReactNode;
  /** Buttons and filters on the right. */
  actions?: ReactNode;
  /** Hide the search capsule (e.g. on full-screen editors with little room). */
  search?: boolean;
  className?: string;
};

/** Page header: eyebrow + title, the search capsule, and actions (like the mockups). */
export default function PageHeader({ title, eyebrow, actions, search = true, className }: Props) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-center gap-4", className)}>
      <div className="flex min-w-[200px] flex-[1_1_220px] flex-col gap-1">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="m-0 text-[30px] font-semibold leading-tight tracking-[-0.02em] text-text">{title}</h1>
      </div>
      {search && <SearchCapsule className="max-md:order-last max-md:basis-full" />}
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}
