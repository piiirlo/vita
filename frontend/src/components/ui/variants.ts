/** Class recipes shared by the UI primitives (kept out of the component files so React
 * fast refresh keeps working). */
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-sans font-medium",
    "border cursor-pointer select-none transition-[background-color,border-color,color,filter,box-shadow]",
    "duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
  ],
  {
    variants: {
      variant: {
        // The one loud action on a screen: orange with dark text.
        primary: "bg-accent text-accent-fg border-accent font-semibold hover:brightness-[1.07]",
        secondary: "bg-transparent text-text border-border-strong hover:bg-hover hover:border-border-hover",
        ghost: "bg-transparent text-muted border-transparent hover:bg-hover hover:text-text",
        danger: "bg-transparent text-danger border-danger-border hover:bg-danger-bg",
        inverse: "bg-inverse text-inverse-fg border-inverse hover:brightness-110",
      },
      size: {
        sm: "h-8 px-3 text-[13px] rounded-[10px]",
        md: "h-10 px-4 text-sm rounded-control",
        lg: "h-12 px-5 text-[15px] rounded-control",
        icon: "h-10 w-10 p-0 rounded-control",
        "icon-sm": "h-8 w-8 p-0 rounded-[10px]",
        pill: "h-[30px] px-3 text-xs font-mono rounded-pill",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export const fieldClass = cn(
  "w-full h-10 px-3 rounded-control border border-border-strong bg-surface text-text font-sans text-sm",
  "placeholder:text-faint transition-[border-color,box-shadow] duration-200",
  "hover:border-border-hover focus:outline-none focus-visible:border-[var(--focus-ring)] focus-visible:ring-2 focus-visible:ring-accent-soft",
  "disabled:opacity-60 disabled:cursor-not-allowed",
);

export const dialogOverlayClass = "anim-fade fixed inset-0 z-[60] bg-overlay backdrop-blur-[2px]";
export const dialogContentClass = cn(
  "anim-pop fixed left-1/2 top-[12vh] z-[61] -translate-x-1/2 max-h-[80vh] overflow-y-auto",
  "w-[min(460px,calc(100vw-32px))] rounded-card border border-border bg-surface p-6 text-text",
  "shadow-[0_30px_80px_-30px_var(--shadow)] focus:outline-none",
);
