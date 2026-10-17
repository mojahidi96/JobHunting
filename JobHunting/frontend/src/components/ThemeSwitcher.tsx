import { api } from "../api";
import { useAuth } from "../auth";
import { useTheme, type Theme } from "../theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";
import { cn } from "./ui";

const OPTIONS: { value: Theme; label: string; Icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

/** Segmented Light / Dark / System control built on native radios (arrow-key navigation for free). */
export function ThemeSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { theme, setTheme } = useTheme();
  const { user } = useAuth();
  const pick = (t: Theme) => {
    setTheme(t);
    if (user) void api.saveProfile({ theme: t }).catch(() => undefined); // best-effort sync to the account
  };
  return (
    <fieldset className={cn("inline-flex rounded-lg border border-border bg-surface-muted p-0.5", className)}>
      <legend className="sr-only">Colour theme</legend>
      {OPTIONS.map(({ value, label, Icon }) => (
        <label key={value} title={`${label} theme`} className={cn("relative flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted transition-colors has-[:checked]:bg-surface has-[:checked]:text-foreground has-[:checked]:shadow-card has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring", "max-sm:min-h-9")}>
          <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => pick(value)} className="sr-only" />
          <Icon className="size-4" />
          <span className={compact ? "sr-only" : undefined}>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}
