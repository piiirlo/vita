import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../../lib/cn.ts";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.List ref={ref} className={cn("inline-flex flex-wrap items-center gap-2", className)} {...props} />
  ),
);
TabsList.displayName = "TabsList";

/** A tab: outlined; the active one has an ink border and an accent underline (like SQL Lab). */
export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "h-9 cursor-pointer rounded-[10px] border border-border bg-transparent px-3.5 font-sans text-[13px] text-muted",
        "transition-[background-color,border-color,color] duration-200 hover:bg-hover hover:text-text",
        "data-[state=active]:border-text data-[state=active]:bg-surface data-[state=active]:text-text",
        "data-[state=active]:shadow-[inset_0_-2px_0_var(--accent)]",
        className,
      )}
      {...props}
    />
  ),
);
TabsTrigger.displayName = "TabsTrigger";
