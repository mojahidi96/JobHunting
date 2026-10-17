import { createContext, forwardRef, useCallback, useContext, useId, useMemo, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { CheckIcon, CloseIcon } from "./icons";

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ----------------------------------------------------------------- Button */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover shadow-card",
  secondary: "bg-surface-muted text-foreground hover:bg-border",
  outline: "border border-border bg-surface text-foreground hover:bg-surface-muted shadow-card",
  ghost: "text-foreground hover:bg-surface-muted",
  danger: "border border-danger/40 bg-surface text-danger hover:bg-danger-soft",
};
const SIZE = { sm: "min-h-9 px-3 text-sm", md: "min-h-10 px-4 text-sm", lg: "min-h-12 px-6 text-base" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: keyof typeof SIZE; loading?: boolean; full?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "outline", size = "md", loading, full, className, children, disabled, type = "button", ...p }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cn("inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11", VARIANT[variant], SIZE[size], full && "w-full", className)} {...p}>
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", className ?? "size-5")} />;
}

/* ------------------------------------------------------------------ Forms */
const CONTROL = "block w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card placeholder:text-muted/70 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-70 aria-[invalid=true]:border-danger";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(CONTROL, "min-h-10 max-sm:min-h-11", className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) {
  return <select ref={ref} className={cn(CONTROL, "min-h-10 max-sm:min-h-11", className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(CONTROL, "py-2", className)} {...p} />;
});

/** Persistent visible label + optional hint/error, wired with aria-describedby. */
export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; className?: string; children: (a: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode }) {
  const id = useId();
  const desc = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      {children({ id, "aria-describedby": desc, "aria-invalid": error ? true : undefined })}
      {error ? <p id={`${id}-e`} className="text-xs font-medium text-danger">{error}</p> : hint ? <p id={`${id}-h`} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, className, ...p }: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={cn("flex items-start gap-2.5 text-sm", className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 rounded border-border accent-[var(--primary)]" {...p} />
      <span>{label}</span>
    </label>
  );
}

/* -------------------------------------------------------- Cards and badges */
export function Card({ className, children, ...p }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-border bg-surface shadow-card", className)} {...p}>{children}</div>;
}
export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div><h2 className="text-base font-semibold">{title}</h2>{description && <p className="mt-0.5 text-sm text-muted">{description}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "primary";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-muted text-muted ring-border",
  success: "bg-success-soft text-success ring-success/30",
  danger: "bg-danger-soft text-danger ring-danger/30",
  warning: "bg-warning-soft text-warning ring-warning/30",
  info: "bg-info-soft text-info ring-info/30",
  primary: "bg-primary-soft text-primary ring-primary/30",
};
export const Badge = ({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) => (
  <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", TONE[tone], className)}>{children}</span>
);

export function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={cn("mt-1 text-3xl font-semibold tabular-nums", tone === "success" && "text-success", tone === "danger" && "text-danger")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

/* ---------------------------------------------- Loading / empty / skeleton */
export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-muted", className)} />;
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 p-5"><span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 grid size-12 place-items-center rounded-full bg-primary-soft text-primary">{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- Responsive table */
export const tableClasses = {
  wrap: "overflow-x-auto md:rounded-b-xl",
  table: "w-full text-left text-sm max-md:block",
  thead: "bg-surface-muted text-xs uppercase tracking-wide text-muted max-md:sr-only",
  th: "px-4 py-3 font-semibold whitespace-nowrap",
  tbody: "max-md:block max-md:space-y-3 max-md:p-3",
  tr: "border-b border-border last:border-0 max-md:block max-md:rounded-lg max-md:border max-md:bg-surface max-md:p-1",
  /** On phones every cell becomes a "label : value" row via data-label. */
  td: "px-4 py-3 align-top break-words md:max-w-xs max-md:grid max-md:grid-cols-[6.5rem_1fr] max-md:gap-2 max-md:px-3 max-md:py-1.5 max-md:before:text-xs max-md:before:font-medium max-md:before:text-muted max-md:before:content-[attr(data-label)]",
};

/* ----------------------------------------------------------------- Toasts */
type ToastKind = "success" | "error" | "info";
interface ToastItem { id: number; kind: ToastKind; message: string }
const ToastCtx = createContext<{ toast: (kind: ToastKind, message: string) => void } | null>(null);
export const useToast = () => { const c = useContext(ToastCtx); if (!c) throw new Error("ToastProvider missing"); return c.toast; };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const toast = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l.slice(-3), { id, kind, message }]);
    setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4500);
  }, [dismiss]);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={cn("pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg", t.kind === "success" && "border-success/40 bg-success-soft text-success", t.kind === "error" && "border-danger/40 bg-danger-soft text-danger", t.kind === "info" && "border-info/40 bg-info-soft text-info")}>
            {t.kind === "success" && <CheckIcon className="mt-0.5 size-4 shrink-0" />}
            <p className="flex-1">{t.message}</p>
            <button type="button" aria-label="Dismiss notification" className="rounded p-0.5 hover:bg-black/10" onClick={() => dismiss(t.id)}><CloseIcon className="size-4" /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
