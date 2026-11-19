import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };

type Props = {
  value: string;
  onValueChange(value: string): void;
  options: SelectOption[];
  /** Accessible name (a Radix select has no native label). */
  "aria-label": string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

/** A styled single select (Radix). Where a native select is better (forms driven by tests,
 * mobile pickers), style a native select with `fieldClass` from input.tsx instead. */
export function Select({ value, onValueChange, options, placeholder, disabled, className, ...rest }: Props) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={rest["aria-label"]}
        className={cn(
          "inline-flex h-[42px] w-full cursor-pointer items-center justify-between gap-2 rounded-control border-0",
          "bg-surface-2 px-[13px] font-sans text-sm font-medium text-text shadow-[inset_0_0_0_1px_var(--border-strong)]",
          "transition-[box-shadow] duration-200 hover:shadow-[inset_0_0_0_1px_var(--border-hover)]",
          "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--accent),0_0_0_4px_var(--accent-soft)]",
          "data-[placeholder]:text-faint disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown size={16} className="text-muted" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="anim-menu z-[70] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-menu bg-surface-raised p-1.5 text-text shadow-[var(--panel-shadow)]"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex h-[38px] cursor-pointer select-none items-center rounded-[10px] pl-2.5 pr-8 text-[13.5px] font-semibold outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-3"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
                  <Check size={16} className="text-accent-text" aria-hidden />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
