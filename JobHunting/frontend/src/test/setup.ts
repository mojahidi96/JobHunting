import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom has no matchMedia; a controllable fake lets tests flip the OS colour scheme.
export const media = { dark: false, listeners: new Set<(e: { matches: boolean }) => void>() };
beforeEach(() => {
  media.dark = false; media.listeners.clear();
  localStorage.clear(); document.documentElement.classList.remove("dark");
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() { return q.includes("dark") ? media.dark : false; },
    media: q, addEventListener: (_: string, l: (e: { matches: boolean }) => void) => media.listeners.add(l),
    removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => media.listeners.delete(l),
  }));
});
afterEach(() => vi.unstubAllGlobals());
