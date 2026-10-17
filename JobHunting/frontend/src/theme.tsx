import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "jh_theme"; // the only thing this app keeps in localStorage

const read = (): Theme => {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" || v === "system" ? v : "system"; } catch { return "system"; }
};
const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
  return dark;
}

interface ThemeState { theme: Theme; resolved: "light" | "dark"; setTheme: (t: Theme) => void }
const Ctx = createContext<ThemeState | null>(null);
export const useTheme = () => { const c = useContext(Ctx); if (!c) throw new Error("ThemeProvider missing"); return c; };

export function ThemeProvider({ children, onChange }: { children: ReactNode; onChange?: (t: Theme) => void }) {
  const [theme, setThemeState] = useState<Theme>(read);
  const [resolved, setResolved] = useState<"light" | "dark">(() => (apply(read()) ? "dark" : "light"));

  const setTheme = useCallback((t: Theme) => {
    try { localStorage.setItem(KEY, t); } catch { /* storage unavailable: preference lasts for this tab only */ }
    setThemeState(t);
    setResolved(apply(t) ? "dark" : "light");
    onChange?.(t);
  }, [onChange]);

  // "System" follows the OS live.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => setResolved(apply("system") ? "dark" : "light");
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [theme]);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Adopt the account's saved preference when signed in on a device that has none stored. */
export const hasStoredTheme = () => { try { return localStorage.getItem(KEY) !== null; } catch { return false; } };
