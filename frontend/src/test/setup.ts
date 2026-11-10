import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { clearToasts } from "../components/toast.ts";

// findBy* / waitFor: pages debounce work (e.g. the chart editor waits 600 ms before
// running), so the default 1 s is too tight when the whole suite runs in parallel.
// 8 s: the chart editor test (600 ms debounce + a few renders) took 2 s on its own but
// occasionally passed 4 s while other workers load the real Monaco in parallel.
configure({ asyncUtilTimeout: 8000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
  clearToasts();
  vi.restoreAllMocks();
});

// jsdom doesn't implement these; TanStack Virtual and the grid use them.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// cmdk (command palette) scrolls the selected item into view; jsdom has no layout.
Element.prototype.scrollIntoView ??= function () {};

// Browser APIs the real Monaco touches when it loads (used by monacoSetup.test.ts).
document.queryCommandSupported ??= () => false;
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList;

// jsdom has no layout: every element is 0x0, so a virtualized grid would render no
// rows. Give elements a plausible size.
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get: () => 600 },
  offsetWidth: { configurable: true, get: () => 1000 },
  clientHeight: { configurable: true, get: () => 600 },
  clientWidth: { configurable: true, get: () => 1000 },
});
HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 1000, width: 1000, height: 600, toJSON: () => ({}) };
};
