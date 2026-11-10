import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export const TooltipProvider = TooltipPrimitive.Provider;

type Props = {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
};

/** A small ink tooltip. The trigger keeps its own accessible name. */
export function Tooltip({ content, children, side = "top", className }: Props) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          className={cn(
            "anim-pop z-[80] rounded-[10px] bg-inverse px-2.5 py-1.5 text-[13px] font-medium text-inverse-fg shadow-lg",
            className,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
