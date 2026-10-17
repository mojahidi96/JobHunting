import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, newIdempotencyKey } from "../api";
import type { HistoryItem, Job, PreviewResponse, Template } from "../types";
import { Alert, ErrorAlert, Modal, PreviewFrame, StatusBadge } from "./common";
import { useConfirm } from "./confirm";
import { Button, Checkbox, Field, Input, Select } from "./ui";
import { TemplateEditor } from "./TemplateEditor";

export function SendDialog({ contactIds, onClose, onDone }: { contactIds: string[]; onClose: () => void; onDone: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [perSend, setPerSend] = useState<Record<string, string>>({});
  const [skipNo, setSkipNo] = useState(true);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [which, setWhich] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [reviewTick, setReviewTick] = useState(false);
  const [editing, setEditing] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [rows, setRows] = useState<HistoryItem[]>([]);
  const [sending, setSending] = useState(false);
  const key = useRef(newIdempotencyKey());
  const confirmDialog = useConfirm();

  const loadTemplates = async () => {
    const r = await api.templates();
    setTemplates(r.items);
    setTemplateId((cur) => cur || (r.items.find((t) => t.isDefault) ?? r.items[0])?.id || "");
  };
  useEffect(() => { loadTemplates().catch(setError); }, []);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!templateId || job) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const p = await api.preview({ templateId, contactIds, perSendValues: perSend, options: { skipRowsMarkedNo: skipNo } });
        if (!cancelled) { setPreview(p); setWhich(0); }
      } catch (e) { if (!cancelled) { setError(e); setPreview(null); } } finally { if (!cancelled) setLoading(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [templateId, perSend, skipNo, contactIds, job, tick]);

  // Poll the real job state.
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const t = setInterval(async () => {
      try { const r = await api.job(job.jobId, true); setJob(r.job); setRows(r.recipients); if (!["queued", "running"].includes(r.job.status)) onDone(); } catch (e) { setError(e); }
    }, 2000);
    return () => clearInterval(t);
  }, [job, onDone]);

  async function send() {
    setSending(true); setError(null);
    try {
      const r = await api.send({ templateId, contactIds, perSendValues: perSend, options: { skipRowsMarkedNo: skipNo }, idempotencyKey: key.current });
      setJob(r.job);
      const d = await api.job(r.job.jobId); setJob(d.job); setRows(d.recipients);
    } catch (e) { setError(e); } finally { setSending(false); }
  }
  async function retry() {
    if (!job || !(await confirmDialog({ title: "Retry failed recipients?", message: "Only recipients that are safe to retry are included. This creates a new job.", confirmLabel: "Retry now" }))) return;
    setSending(true); setError(null);
    try { const r = await api.retry(job.jobId, newIdempotencyKey()); setJob(r.job); setRows([]); const d = await api.job(r.job.jobId); setJob(d.job); setRows(d.recipients); }
    catch (e) { setError(e); } finally { setSending(false); }
  }
  async function review() {
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    try { await api.reviewTemplate(t.id, t.version); await loadTemplates(); setReviewTick(false); setTick((n) => n + 1); } catch (e) { setError(e); }
  }

  const sel = preview?.items[which];
  const p = preview;
  const minutes = p ? Math.ceil(((p.summary.eligible - 1) * (p.options.delayMinMs + p.options.delayMaxMs) / 2) / 60000) : 0;
  const running = job && ["queued", "running"].includes(job.status);
  const done = job && !running;
  const failedRetryable = rows.some((r) => r.status === "failed" && r.error?.retryable && !r.retried);

  return (
    <Modal title={job ? "Sending emails" : "Review and send"} size="lg" onClose={async () => { if (running && !(await confirmDialog({ title: "Close while sending?", message: "The job keeps running on the server even if you close this window. You can follow it in Email History.", confirmLabel: "Close window", cancelLabel: "Stay" }))) return; onClose(); }}
      footer={job ? <>
        {done && failedRetryable && <Button onClick={retry} loading={sending}>Retry eligible failures</Button>}
        <Button variant="primary" onClick={onClose}>{running ? "Hide (keeps running)" : "Close"}</Button>
      </> : <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={sending} disabled={!p?.canSend || !confirm || loading} onClick={send}>{`Send ${p?.summary.eligible ?? 0} email${p?.summary.eligible === 1 ? "" : "s"}`}</Button>
      </>}>
      <ErrorAlert error={error} />
      {job ? (
        <div aria-live="polite" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3"><StatusBadge status={job.status} /><span className="text-sm">{job.totals.sent} sent · {job.totals.failed} failed · {job.totals.skipped} skipped of {job.totals.selected}</span></div>
          <progress className="h-2.5 w-full overflow-hidden rounded-full accent-[var(--primary)]" max={job.totals.selected} value={job.totals.sent + job.totals.failed + job.totals.skipped} aria-label="Job progress" />
          <p className="text-xs text-muted">Sending as {job.sender.senderName} &lt;{job.sender.senderEmail}&gt;. “Sent” means accepted by the email provider, not guaranteed inbox delivery. Emails go out one at a time with a pause between them; you can leave this page.</p>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-2 px-3 py-2 text-sm"><StatusBadge status={r.status} /><span className="min-w-0 flex-1 break-words">{r.recipient.Name} &lt;{r.recipient.Email}&gt;{r.error && <span className="block text-xs text-muted">{r.error.message}{r.error.retryable ? " (can retry)" : ""}</span>}</span></li>
            ))}
          </ul>
          <p className="text-sm"><Link className="font-medium text-primary hover:underline" to="/history" onClick={onClose}>Open email history</Link></p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Template">{(a) => <Select {...a} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setConfirm(false); }}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}{t.reviewed ? "" : " — needs review"}</option>)}</Select>}</Field>
            <Button onClick={() => setEditing(true)} disabled={!templateId}>Update Email Template</Button>
          </div>

          {p && p.perSendFields.map((k) => <Field key={k} label={`{{${k}}} (for this send)`}>{(a) => <Input {...a} value={perSend[k] ?? ""} onChange={(e) => { setPerSend({ ...perSend, [k]: e.target.value }); setConfirm(false); }} />}</Field>)}
          <Checkbox label="Skip contacts marked isSend = no" checked={skipNo} onChange={(e) => setSkipNo(e.target.checked)} />

          {loading && !p && <p className="text-sm text-muted" role="status">Preparing preview…</p>}
          {p && (
            <>
              <dl className="grid gap-x-6 gap-y-3 rounded-lg bg-surface-muted p-4 text-sm sm:grid-cols-2">
                <div className="sm:col-span-2"><dt className="text-xs text-muted">Sending as</dt><dd className="mt-0.5 flex flex-wrap items-center gap-2 break-all">{p.sender.senderEmail ? `${p.sender.senderName} <${p.sender.senderEmail}>` : "— not configured"} <StatusBadge status={p.sender.status} kind="sender" /></dd></div>
                <div><dt className="text-xs text-muted">Login account</dt><dd className="break-all">{p.sender.loginEmail}</dd></div>
                <div><dt className="text-xs text-muted">Recipients</dt><dd>{p.summary.eligible} will be emailed · {p.summary.skipped} skipped · {p.summary.selected} selected</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs text-muted">Pace</dt><dd>One at a time, {Math.round(p.options.delayMinMs / 1000)}–{Math.round(p.options.delayMaxMs / 1000)} s apart{minutes > 0 ? ` (about ${minutes} min total)` : ""}</dd></div>
              </dl>
              {p.problems.map((pr) => (
                <Alert key={pr.code} kind="warn">
                  <p><strong>{pr.message}</strong></p>
                  {pr.details.length > 0 && <ul>{pr.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
                  {pr.code === "SENDER_NOT_VERIFIED" && <p className="mt-2"><Link className="font-medium underline" to="/settings/email" onClick={onClose}>Open Email Sending Settings</Link></p>}
                  {pr.code === "TEMPLATE_NOT_REVIEWED" && (
                    <div className="mt-2 space-y-2">
                      <Checkbox label="I have reviewed this template version (name, experience, skills, contact details, links, wording)." checked={reviewTick} onChange={(e) => setReviewTick(e.target.checked)} />
                      <Button size="sm" disabled={!reviewTick} onClick={review}>Confirm review</Button>
                    </div>
                  )}
                </Alert>
              ))}
              {p.items.some((i) => i.status === "skipped") && (
                <details className="rounded-lg border border-border px-3 py-2 text-sm"><summary className="cursor-pointer font-medium">{p.summary.skipped} skipped</summary><ul className="mt-2 list-disc pl-5">{p.items.filter((i) => i.status === "skipped").map((i) => <li key={i.contactId}>{i.name} — {i.skipReason}</li>)}</ul></details>
              )}
              {p.items.some((i) => i.warnings.length > 0) && (
                <details className="rounded-lg border border-border px-3 py-2 text-sm"><summary className="cursor-pointer font-medium">Warnings</summary><ul className="mt-2 list-disc pl-5">{p.items.filter((i) => i.warnings.length).slice(0, 30).map((i) => <li key={i.contactId}>{i.name}: {i.warnings.join("; ")}</li>)}</ul></details>
              )}
              {p.items.length > 0 && (
                <div className="space-y-2">
                  <Field label="Preview as">{(a) => <Select {...a} value={which} onChange={(e) => setWhich(Number(e.target.value))}>
                    {p.items.filter((i) => i.html !== null).map((i) => <option key={i.contactId} value={p.items.indexOf(i)}>{i.name} — {i.to}</option>)}</Select>}</Field>
                  {sel && <><p className="text-sm break-words"><strong>To:</strong> {sel.to} <strong className="ml-2">Subject:</strong> {sel.subject}</p>{sel.html !== null && <PreviewFrame html={sel.html} />}</>}
                </div>
              )}
              <div className="rounded-lg border border-primary/40 bg-primary-soft p-4">
                <Checkbox className="font-medium" checked={confirm} disabled={!p.canSend} onChange={(e) => setConfirm(e.target.checked)}
                  label={`I confirm I want to send ${p.summary.eligible} email${p.summary.eligible === 1 ? "" : "s"} from ${p.sender.senderEmail || "my sending account"}.`} />
              </div>
            </>
          )}
        </div>
      )}
      {editing && templates.find((t) => t.id === templateId) && (
        <TemplateEditor template={templates.find((t) => t.id === templateId)!} onSaved={() => undefined} onClose={() => { setEditing(false); void loadTemplates(); setTick((n) => n + 1); }} />
      )}
    </Modal>
  );
}
