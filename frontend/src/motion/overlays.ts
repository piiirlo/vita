/**
 * Overlay entrances with Ignara's GSAP settings (its modal, popover, finder and toast code).
 * Radix renders overlays in portals under <body>; one observer animates each as it mounts.
 * Exits stay CSS keyframes (styles/components.css: Radix waits for them before unmounting).
 * - modal / alert dialog: from 86% at the button that opened it, 0.5s back.out(1.5); scrim 0.3s
 * - menu / select / popover: 92% and 6px up, from its trigger side, 0.4s back.out(2)
 * - command palette (Ignara's finder): 18px up at 97%, 0.45s back.out(1.6)
 * - toast: 30px down at 94%, 0.5s back.out(1.8)
 */
import { gsap, motionOn } from "./ignara.ts";

let lastPointer: { x: number; y: number } | null = null;

function enter(el: HTMLElement) {
  if (el.matches(".anim-pop")) {
    // Scale from where it was opened: the focused trigger, else the last click.
    const anchor = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement.getBoundingClientRect() : null;
    const box = el.getBoundingClientRect();
    const ax = anchor && anchor.width ? anchor.left + anchor.width / 2 : (lastPointer?.x ?? box.left + box.width / 2);
    const ay = anchor && anchor.width ? anchor.top + anchor.height / 2 : (lastPointer?.y ?? box.top + box.height / 2);
    gsap.fromTo(
      el,
      { scale: 0.86, opacity: 0, transformOrigin: `${ax - box.left}px ${ay - box.top}px` },
      { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.5)", clearProps: "transform,opacity,transformOrigin" },
    );
  } else if (el.matches(".anim-menu")) {
    const style = getComputedStyle(el);
    const origin =
      style.getPropertyValue("--radix-dropdown-menu-content-transform-origin").trim() ||
      style.getPropertyValue("--radix-select-content-transform-origin").trim() ||
      style.transformOrigin;
    gsap.fromTo(
      el,
      { scale: 0.92, opacity: 0, y: -6, transformOrigin: origin },
      { scale: 1, opacity: 1, y: 0, duration: 0.4, ease: "back.out(2)", clearProps: "transform,opacity,transformOrigin" },
    );
  } else if (el.matches(".anim-palette")) {
    gsap.fromTo(el, { y: -18, scale: 0.97, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.45, ease: "back.out(1.6)", clearProps: "transform,opacity" });
  } else if (el.matches(".anim-fade")) {
    gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.3, clearProps: "opacity" });
  } else if (el.matches(".toast-root")) {
    gsap.fromTo(el, { y: 30, opacity: 0, scale: 0.94 }, { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.8)", clearProps: "transform,opacity" });
  }
}

const OVERLAYS = ".anim-pop, .anim-menu, .anim-palette, .anim-fade, .toast-root";

/** Start animating overlays as they open; returns a stop function. */
export function enableOverlayMotion(): () => void {
  const onPointer = (e: PointerEvent) => (lastPointer = { x: e.clientX, y: e.clientY });
  document.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  const observer = new MutationObserver((records) => {
    if (!motionOn()) return;
    for (const r of records)
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        const found = n.matches(OVERLAYS) ? [n] : [...n.querySelectorAll<HTMLElement>(OVERLAYS)];
        found.filter((el) => el.dataset.state !== "closed").forEach(enter);
      });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    document.removeEventListener("pointerdown", onPointer, { capture: true });
  };
}
