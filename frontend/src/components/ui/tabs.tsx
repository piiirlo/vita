import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../../lib/cn.ts";
import { gsap, motionOn, slidePill } from "../../motion/ignara.ts";

function slideIn(el: HTMLElement) {
  if (!motionOn()) return;
  gsap.fromTo(el, { x: 26 }, { x: 0, duration: 0.7, ease: "expo.out", clearProps: "transform" });
}

export const Tabs = TabsPrimitive.Root;
/** A tab's content. Switching tabs slides the new content in 26px (Ignara's view swap, 0.7s
 * expo.out); the first one shown doesn't move. */
const shownTabs = new WeakSet<Element>();
export const TabsContent = forwardRef<ElementRef<typeof TabsPrimitive.Content>, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  (props, ref) => {
    const own = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
      const el = own.current;
      const root = el?.parentElement;
      if (!el || !root) return;
      if (shownTabs.has(root)) slideIn(el);
      else shownTabs.add(root);
    }, []);
    return (
      <TabsPrimitive.Content
        ref={(node) => {
          own.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        {...props}
      />
    );
  },
);
TabsContent.displayName = "TabsContent";

/** The segmented control's track. Its thumb (the inverted pill) slides to the active segment
 * and stretches on the way (Ignara's .seg__thumb). */
export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  ({ className, children, ...props }, ref) => {
    const thumb = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
      const list = thumb.current?.parentElement;
      if (!list) return;
      const place = (animate: boolean) =>
        slidePill(thumb.current, list.querySelector<HTMLElement>('[role="tab"][data-state="active"]'), { radius: 10, animate });
      place(false);
      const changes = new MutationObserver(() => place(true));
      changes.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-state"], childList: true });
      let size = `${list.offsetWidth}x${list.offsetHeight}`;
      const resize =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => {
              const now = `${list.offsetWidth}x${list.offsetHeight}`;
              if (now !== size) place(false);
              size = now;
            });
      resize?.observe(list);
      return () => {
        changes.disconnect();
        resize?.disconnect();
      };
    }, []);
    return (
      <TabsPrimitive.List
        ref={ref}
        className={cn(
          "relative inline-flex flex-wrap items-center gap-0.5 rounded-button bg-surface-2 p-[3px] shadow-[inset_0_0_0_1px_var(--border)]",
          className,
        )}
        {...props}
      >
        <span
          ref={thumb}
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-inverse opacity-0 [filter:drop-shadow(0_4px_6px_var(--shadow-color))]"
        />
        {children}
      </TabsPrimitive.List>
    );
  },
);
TabsList.displayName = "TabsList";

/** A segment of the segmented control (Ignara's .seg): the active one is the inverted thumb. */
export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "relative z-[1] inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[10px] border-0 bg-transparent px-3 font-sans text-[12.5px] font-semibold text-muted",
        "transition-[color] duration-300 ease-[var(--ease-out)] hover:text-text",
        "data-[state=active]:text-inverse-fg",
        className,
      )}
      {...props}
    />
  ),
);
TabsTrigger.displayName = "TabsTrigger";
