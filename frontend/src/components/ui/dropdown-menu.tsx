import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../../lib/cn.ts";
import { menuItemClass, menuPanelClass } from "./variants.ts";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuSub = Menu.Sub;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

const panel = menuPanelClass;
const item = menuItemClass;

export const DropdownMenuContent = forwardRef<ElementRef<typeof Menu.Content>, ComponentPropsWithoutRef<typeof Menu.Content>>(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <Menu.Portal>
      <Menu.Content ref={ref} sideOffset={sideOffset} className={cn(panel, className)} {...props} />
    </Menu.Portal>
  ),
);
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<ElementRef<typeof Menu.Item>, ComponentPropsWithoutRef<typeof Menu.Item>>(
  ({ className, ...props }, ref) => <Menu.Item ref={ref} className={cn(item, className)} {...props} />,
);
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof Menu.Label>) {
  return <Menu.Label className={cn("eyebrow px-2.5 pb-1 pt-2", className)} {...props} />;
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="mx-1 my-1.5 h-px bg-border-strong" />;
}

export const DropdownMenuSubTrigger = forwardRef<ElementRef<typeof Menu.SubTrigger>, ComponentPropsWithoutRef<typeof Menu.SubTrigger>>(
  ({ className, children, ...props }, ref) => (
    <Menu.SubTrigger ref={ref} className={cn(item, "data-[state=open]:bg-surface-3", className)} {...props}>
      {children}
      <ChevronRight size={16} className="ml-auto text-muted" aria-hidden />
    </Menu.SubTrigger>
  ),
);
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = forwardRef<ElementRef<typeof Menu.SubContent>, ComponentPropsWithoutRef<typeof Menu.SubContent>>(
  ({ className, ...props }, ref) => (
    <Menu.Portal>
      <Menu.SubContent ref={ref} sideOffset={6} className={cn(panel, "min-w-[160px]", className)} {...props} />
    </Menu.Portal>
  ),
);
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

export const DropdownMenuRadioItem = forwardRef<ElementRef<typeof Menu.RadioItem>, ComponentPropsWithoutRef<typeof Menu.RadioItem>>(
  ({ className, children, ...props }, ref) => (
    <Menu.RadioItem ref={ref} className={cn(item, "pr-8", className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2.5 inline-flex">
        <Check size={16} className="text-accent-text" aria-hidden />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  ),
);
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";
