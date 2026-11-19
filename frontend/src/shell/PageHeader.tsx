import { Search } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { motionOn, revealTitle } from "../motion/ignara.ts";
import { openCommandPalette } from "./commandPaletteStore.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The search field (Ignara's): opens the command palette (also Ctrl+K / Cmd+K). */
export function SearchCapsule({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label="Search and commands"
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      className={cn(
        "flex h-11 min-w-0 flex-[0_1_420px] cursor-pointer items-center gap-2.5 rounded-[14px] border-0",
        "bg-surface py-0 pl-3.5 pr-2 font-sans text-[13.5px] font-medium text-muted shadow-[inset_0_0_0_1px_var(--border)]",
        "transition-[background-color,color,box-shadow] duration-200 hover:bg-surface hover:text-text-2 hover:shadow-[inset_0_0_0_1px_var(--border-strong)]",
        className,
      )}
    >
      <Search size={18} strokeWidth={1.8} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">Jump to a chart, table or query…</span>
      <kbd className="kbd">
        {isMac ? "⌘ K" : "Ctrl K"}
      </kbd>
    </button>
  );
}

type Props = {
  title: ReactNode;
  /** Small uppercase line above the title, e.g. "SPACES / SALES". */
  eyebrow?: ReactNode;
  /** Buttons and filters on the right. */
  actions?: ReactNode;
  /** Unused since the top bar holds the search (kept so callers needn't change). */
  search?: boolean;
  className?: string;
};

/** A string title as words of letter spans (Ignara's split title), so its letters can rise
 * in; the heading keeps the plain text as its name. Other titles render as they are. */
export function TitleText({ title }: { title: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const split = typeof title === "string" && motionOn();
  useLayoutEffect(() => {
    if (split && ref.current) revealTitle(ref.current.querySelectorAll(".ch"));
  }, [split, title]);
  if (!split) return <>{title}</>;
  return (
    <span ref={ref} aria-hidden>
      {title.split(" ").map((word, w) => (
        <span key={w}>
          {w > 0 && " "}
          <span className="word">
            {[...word].map((ch, c) => (
              <span key={c} className="ch">
                {ch}
              </span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Page header: eyebrow + title, the search capsule, and actions (like the mockups). */
export default function PageHeader({ title, eyebrow, actions, className }: Props) {
  const label = typeof title === "string" && motionOn() ? title : undefined;
  return (
    <header className={cn("mb-5 mt-2.5 flex flex-wrap items-end gap-4", className)}>
      <div className="flex min-w-[200px] flex-[1_1_260px] flex-col gap-1.5">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 aria-label={label} className="m-0 text-[clamp(28px,2.6vw,38px)] font-semibold leading-[1.04] tracking-[-0.025em] text-text">
          <TitleText key={typeof title === "string" ? title : undefined} title={title} />
        </h1>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}
