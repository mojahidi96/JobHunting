import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Modal } from "./common";
import { Button, Field, Input } from "./ui";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" styles the confirm button as destructive. */
  tone?: "default" | "danger";
}
export interface PromptOptions {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  message?: ReactNode;
}

type Pending =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

interface Api { confirm: (o: ConfirmOptions) => Promise<boolean>; prompt: (o: PromptOptions) => Promise<string | null> }
const Ctx = createContext<Api | null>(null);

/** In-app replacements for window.confirm / window.prompt: themed, accessible, keyboard- and touch-friendly. */
export const useConfirm = () => { const c = useContext(Ctx); if (!c) throw new Error("ConfirmProvider missing"); return c.confirm; };
export const usePrompt = () => { const c = useContext(Ctx); if (!c) throw new Error("ConfirmProvider missing"); return c.prompt; };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { kind: "confirm", opts, resolve }])), []);
  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>((resolve) => setQueue((q) => [...q, { kind: "prompt", opts, resolve }])), []);
  const value = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  const current = queue[0];
  const settle = (result: boolean | string | null) => {
    if (!current) return;
    (current.resolve as (v: boolean | string | null) => void)(result);
    setQueue((q) => q.slice(1));
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {current?.kind === "confirm" && <ConfirmDialog key={queue.length} opts={current.opts} onResult={settle} />}
      {current?.kind === "prompt" && <PromptDialog key={queue.length} opts={current.opts} onResult={settle} />}
    </Ctx.Provider>
  );
}

function ConfirmDialog({ opts, onResult }: { opts: ConfirmOptions; onResult: (v: boolean) => void }) {
  return (
    <Modal title={opts.title} size="sm" layer="top" onClose={() => onResult(false)} footer={<>
      <Button onClick={() => onResult(false)}>{opts.cancelLabel ?? "Cancel"}</Button>
      <Button variant={opts.tone === "danger" ? "danger" : "primary"} className={opts.tone === "danger" ? "bg-danger text-primary-foreground hover:opacity-90 border-transparent dark:text-background" : undefined} onClick={() => onResult(true)}>{opts.confirmLabel ?? "Confirm"}</Button>
    </>}>
      <div className="text-sm text-muted">{opts.message}</div>
    </Modal>
  );
}

function PromptDialog({ opts, onResult }: { opts: PromptOptions; onResult: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initialValue ?? "");
  const submit = () => { if (value.trim()) onResult(value.trim()); };
  return (
    <Modal title={opts.title} size="sm" layer="top" onClose={() => onResult(null)} footer={<>
      <Button onClick={() => onResult(null)}>Cancel</Button>
      <Button variant="primary" disabled={!value.trim()} onClick={submit}>{opts.confirmLabel ?? "Save"}</Button>
    </>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
        {opts.message && <div className="text-sm text-muted">{opts.message}</div>}
        <Field label={opts.label}>{(a) => <Input {...a} value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} />}</Field>
      </form>
    </Modal>
  );
}
