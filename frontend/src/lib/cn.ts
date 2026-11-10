import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge our custom radius names so `rounded-card` and `rounded-control` merge.
const twMerge = extendTailwindMerge({
  extend: { theme: { radius: ["card", "control", "pill"] } },
});

/** Join class names; later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
