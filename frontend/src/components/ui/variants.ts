/** Class recipes shared by the UI primitives (kept out of the component files so React
 * fast refresh keeps working). The Ignara look: hairlines are inset shadows, not borders. */
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-sans font-semibold",
    "border border-transparent cursor-pointer select-none",
    "transition-[background-color,color,filter,box-shadow,transform] duration-200 ease-[var(--ease-std)]",
    "active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
    "[&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        // The one loud action on a screen: ember with dark text and a soft glow.
        primary: "bg-accent text-accent-fg shadow-[var(--primary-shadow)] hover:brightness-[1.05]",
        secondary: "bg-surface text-text shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-surface-2",
        ghost: "bg-transparent text-muted hover:bg-surface-3 hover:text-text",
        danger: "bg-surface text-danger shadow-[inset_0_0_0_1px_var(--danger-border)] hover:bg-danger-bg",
        // Ink on the page (Ignara's dark button).
        inverse: "bg-inverse text-inverse-fg hover:brightness-110",
      },
      size: {
        sm: "h-8 px-3 text-[12.5px] rounded-[10px] [&_svg]:size-4",
        md: "h-10 px-4 text-[13.5px] rounded-button [&_svg]:size-[18px]",
        lg: "h-[52px] px-[22px] text-[15px] rounded-[15px]",
        icon: "h-10 w-10 p-0 rounded-button",
        "icon-sm": "h-8 w-8 p-0 rounded-[10px]",
        pill: "h-8 px-3 text-xs rounded-[10px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export const fieldClass = cn(
  "w-full h-[42px] px-[13px] rounded-control border-0 bg-surface-2 text-text font-sans text-sm font-medium",
  "shadow-[inset_0_0_0_1px_var(--border-strong)] placeholder:text-faint",
  "transition-[box-shadow,background-color] duration-200 ease-[var(--ease-std)]",
  "hover:shadow-[inset_0_0_0_1px_var(--border-hover)]",
  "focus:outline-none focus-visible:outline-none focus:shadow-[inset_0_0_0_1.5px_var(--accent),0_0_0_4px_var(--accent-soft)]",
  "disabled:opacity-60 disabled:cursor-not-allowed",
);

export const dialogOverlayClass = "anim-fade fixed inset-0 z-[60] bg-overlay";
export const dialogContentClass = cn(
  "anim-pop fixed left-1/2 top-[12vh] z-[61] -translate-x-1/2 max-h-[80vh] overflow-y-auto",
  "w-[min(520px,calc(100vw-32px))] rounded-xl bg-surface-raised px-6 pb-5 pt-[22px] text-text",
  "shadow-[var(--panel-shadow)] focus:outline-none",
);

/** Menus, popovers and select lists: the panel color, radius 16, 6px padding. */
export const menuPanelClass = cn(
  "anim-menu z-[70] min-w-[200px] overflow-hidden rounded-menu bg-surface-raised p-1.5 text-text",
  "shadow-[var(--panel-shadow)]",
);
export const menuItemClass = cn(
  "relative flex h-[38px] cursor-pointer select-none items-center gap-2.5 rounded-[10px] px-2.5",
  "text-[13.5px] font-semibold text-text outline-none",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-3",
  "[&_svg]:text-muted",
);
