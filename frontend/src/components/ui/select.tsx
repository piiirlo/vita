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
          "inline-flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-control border border-border-strong",
          "bg-surface px-3 font-sans text-sm text-text hover:border-border-hover focus-visible:border-[var(--focus-ring)]",
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
          className="anim-pop z-[70] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[16px] border border-border-strong bg-surface-raised p-1.5 text-text shadow-[0_18px_50px_-20px_var(--shadow)]"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-pointer select-none items-center rounded-[10px] py-2 pl-2.5 pr-8 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover"
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
