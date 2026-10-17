import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import type { DeliveryStatus, JobStatus } from "../types";
import { CloseIcon } from "./icons";
import { Badge, Button, Skeleton, cn, type Tone } from "./ui";

// Open modals, innermost last. Only the top one handles Escape/Tab, so a confirm dialog can sit on top of another modal.
const modalStack: symbol[] = [];

/** Accessible modal: focus trap, Escape to close, focus restored on close; full-screen on phones. */
export function Modal({ title, onClose, children, size = "md", footer, layer = "base" }: {
  title: string; onClose: () => void; children: ReactNode; size?: "md" | "lg" | "sm"; footer?: ReactNode; layer?: "base" | "top";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const id = Symbol("modal");
    modalStack.push(id);
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])");
    (first ?? ref.current)?.focus();
    const key = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return;
      if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", key);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", key);
      modalStack.splice(modalStack.indexOf(id), 1);
      if (modalStack.length === 0) document.body.classList.remove("modal-open");
      prev?.focus?.();
    };
  }, []);
  return (
    <div className={cn("fixed inset-0 grid place-items-center overflow-y-auto bg-slate-950/60 p-0 backdrop-blur-[2px] sm:p-6", layer === "top" ? "z-[65]" : "z-50")}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={cn("flex w-full flex-col bg-surface shadow-2xl outline-none sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:border sm:border-border",
          size === "sm" ? "max-sm:mt-auto max-sm:rounded-t-2xl sm:max-w-md" : cn("h-dvh", size === "lg" ? "sm:max-w-5xl" : "sm:max-w-xl"))}>
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" data-close aria-label="Close dialog" onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-surface-muted hover:text-foreground"><CloseIcon /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3 max-sm:[&>button]:flex-1">{footer}</div>}
      </div>
    </div>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "… Pending", tone: "neutral" }, sent: { label: "✓ Sent", tone: "success" }, failed: { label: "✕ Failed", tone: "danger" }, skipped: { label: "– Skipped", tone: "warning" },
  queued: { label: "… Queued", tone: "neutral" }, running: { label: "▶ Running", tone: "info" }, completed: { label: "✓ Completed", tone: "success" }, completed_with_errors: { label: "⚠ Completed with errors", tone: "warning" },
  verified: { label: "✓ Verified", tone: "success" }, unverified: { label: "… Not verified", tone: "warning" }, not_configured: { label: "– Not configured", tone: "neutral" },
};
/** Always text + symbol, never colour alone. */
export function StatusBadge({ status, kind }: { status: DeliveryStatus | JobStatus | string; kind?: "sender" }) {
  const s = kind === "sender" && status === "failed" ? { label: "✕ Failed", tone: "danger" as Tone } : STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const ALERT: Record<string, string> = {
  error: "border-danger/40 bg-danger-soft text-danger", warn: "border-warning/40 bg-warning-soft text-warning",
  ok: "border-success/40 bg-success-soft text-success", info: "border-info/40 bg-info-soft text-info",
};
export function Alert({ kind = "error", children, onRetry, className }: { kind?: "error" | "warn" | "ok" | "info"; children: ReactNode; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn("my-3 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm", ALERT[kind], className)} role={kind === "error" ? "alert" : "status"}>
      <div className="min-w-0 flex-1 [&_ul]:mt-1 [&_ul]:list-disc [&_ul]:pl-5 [&_p+p]:mt-1">{children}</div>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <Alert onRetry={onRetry}>
      <p>{e.message || "Something went wrong."}</p>
      {e.details?.length ? <ul>{e.details.slice(0, 8).map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
    </Alert>
  );
}

export const Loading = ({ label = "Loading…" }: { label?: string }) => (
  <div role="status" aria-live="polite" className="space-y-3 py-2"><span className="sr-only">{label}</span><Skeleton className="h-8 w-1/3" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>
);
export const Dash = ({ v }: { v: string | null | undefined }) => <>{v ? v : <span aria-label="empty">—</span>}</>;

/** Untrusted email HTML is only ever rendered in a sandboxed iframe (no scripts, no same-origin access). */
export function PreviewFrame({ html, title = "Email preview" }: { html: string; title?: string }) {
  const doc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.55 system-ui,sans-serif;margin:14px;color:#111;background:#fff}a{color:#4338ca}</style>${html}`;
  return <iframe title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={doc} className="h-80 w-full rounded-lg border border-border bg-white" />;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="flex flex-wrap items-center gap-3 text-sm text-muted" aria-label="Pagination">
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Previous</Button>
      <span>Page {page} of {pages} · {total} total</span>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</Button>
    </nav>
  );
}

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

/** Small data-loading hook with explicit loading / error / reload states. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => { setLoading(true); setError(null); return fn().then(setData).catch(setError).finally(() => setLoading(false)); }, deps);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}
