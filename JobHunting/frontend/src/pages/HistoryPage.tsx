import { useCallback, useEffect, useState } from "react";
import { api, newIdempotencyKey } from "../api";
import type { HistoryItem, Job } from "../types";
import { Alert, ErrorAlert, Modal, Pagination, StatusBadge, fmtDate } from "../components/common";
import { useConfirm } from "../components/confirm";
import { InboxIcon } from "../components/icons";
import { Button, Card, EmptyState, Field, Input, PageHeader, Select, SkeletonRows, Stat, tableClasses as t, useToast } from "../components/ui";

export function HistoryPage() {
  const [f, setF] = useState({ q: "", status: "", from: "", to: "", sort: "createdAt", order: "desc", page: 1 });
  const [q, setQ] = useState("");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.history>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setData(await api.history({
        q: f.q, status: f.status, sort: f.sort, order: f.order, page: f.page, pageSize: 25,
        from: f.from ? new Date(f.from).toISOString() : undefined, to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : undefined,
      }));
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, [f]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const x = setTimeout(() => setF((s) => (s.q === q ? s : { ...s, q, page: 1 })), 300); return () => clearTimeout(x); }, [q]);

  const c = data?.counts;
  const filtered = !!(f.q || f.status || f.from || f.to);
  return (
    <>
      <PageHeader title="Email History" description="Everything this account has sent, skipped or failed." />
      <Alert kind="info">“Sent” means the email was <strong>accepted by your sending provider</strong>. It does not guarantee the message reached an inbox or was read.</Alert>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Attempted" value={c?.attempted ?? "—"} /><Stat label="Sent" value={c?.sent ?? "—"} tone="success" />
        <Stat label="Failed" value={c?.failed ?? "—"} tone={c?.failed ? "danger" : "neutral"} /><Stat label="Skipped" value={c?.skipped ?? "—"} />
      </div>
      <Card className="mt-6 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <Field className="sm:col-span-2 lg:col-span-2" label="Search">{(a) => <Input {...a} type="search" value={q} placeholder="Recipient name, email, company, role" onChange={(e) => setQ(e.target.value)} />}</Field>
        <Field label="Status">{(a) => <Select {...a} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All</option><option value="sent">Sent</option><option value="failed">Failed</option><option value="skipped">Skipped</option><option value="pending">Pending</option></Select>}</Field>
        <Field label="From">{(a) => <Input {...a} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} />}</Field>
        <Field label="To">{(a) => <Input {...a} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} />}</Field>
        <Field className="sm:col-span-2 lg:col-span-2" label="Sort">{(a) => <Select {...a} value={`${f.sort}:${f.order}`} onChange={(e) => { const [sort, order] = e.target.value.split(":"); setF({ ...f, sort, order, page: 1 }); }}>
          <option value="createdAt:desc">Newest first</option><option value="createdAt:asc">Oldest first</option><option value="Name:asc">Recipient A–Z</option><option value="Company:asc">Company A–Z</option><option value="status:asc">Status</option></Select>}</Field>
      </Card>
      <ErrorAlert error={error} onRetry={load} />
      <Card className="mt-4 overflow-hidden">
        {loading && !data ? <SkeletonRows /> : data && data.items.length === 0 ? (
          <EmptyState icon={<InboxIcon />} title={filtered ? "No records match these filters" : "No emails yet"} description={filtered ? "Try clearing a filter." : "Select recruiters and send from the Recruiters page."} />
        ) : data && (
          <div className={t.wrap} tabIndex={0} aria-label="Email history">
            <table className={t.table}>
              <thead className={t.thead}><tr>{["Recipient", "Company / Role", "Status", "Subject", "Time", "Job"].map((h) => <th key={h} className={t.th}>{h}</th>)}</tr></thead>
              <tbody className={t.tbody}>
                {data.items.map((h) => (
                  <tr key={h.id} className={t.tr}>
                    <td data-label="Recipient" className={t.td}><div className="font-medium">{h.recipient.Name}</div><div className="text-xs text-muted">{h.recipient.Email}</div></td>
                    <td data-label="Company / Role" className={t.td}><div>{h.recipient.Company}</div><div className="text-xs text-muted">{h.recipient.Role}</div></td>
                    <td data-label="Status" className={t.td}><StatusBadge status={h.status} />{h.error && <div className="mt-1 text-xs text-muted">{h.error.message}</div>}</td>
                    <td data-label="Subject" className={t.td}>{h.subject ?? "—"}</td>
                    <td data-label="Time" className={t.td}>{fmtDate(h.completedAt ?? h.createdAt)}</td>
                    <td data-label="Job" className={t.td}><button type="button" className="font-medium text-primary hover:underline" onClick={() => setOpen(h.jobId)}>Details</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data && <div className="mt-4"><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setF({ ...f, page: p })} /></div>}
      {open && <JobDetail jobId={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </>
  );
}

function JobDetail({ jobId, onClose, onChanged }: { jobId: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<{ job: Job; recipients: HistoryItem[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [id, setId] = useState(jobId);
  const toast = useToast();
  const confirm = useConfirm();
  const load = useCallback(async (jid: string, background = false) => { try { setD(await api.job(jid, background)); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(id); }, [id, load]);
  useEffect(() => {
    if (!d || !["queued", "running"].includes(d.job.status)) return;
    const x = setInterval(() => void load(id, true), 2500); // background polling never extends the session
    return () => clearInterval(x);
  }, [d, id, load]);

  const retryable = d?.recipients.filter((r) => r.status === "failed" && r.error?.retryable && !r.retried) ?? [];
  async function retry() {
    if (!d || !(await confirm({ title: `Retry ${retryable.length} failed recipient${retryable.length === 1 ? "" : "s"}?`, message: "This creates a new job. Messages with an unknown outcome are never retried automatically.", confirmLabel: "Retry now" }))) return;
    setBusy(true); setError(null);
    try { const r = await api.retry(d.job.jobId, newIdempotencyKey()); setId(r.job.jobId); onChanged(); toast("success", "Retry job started."); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Modal title="Job details" size="lg" onClose={onClose} footer={<>
      {retryable.length > 0 && <Button onClick={retry} loading={busy}>Retry {retryable.length} eligible failure(s)</Button>}
      <Button variant="primary" onClick={onClose}>Close</Button>
    </>}>
      <ErrorAlert error={error} />
      {!d ? <SkeletonRows rows={4} /> : (
        <>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Status</dt><dd className="mt-0.5"><StatusBadge status={d.job.status} /></dd></div>
            <div><dt className="text-xs text-muted">Sent as</dt><dd className="break-all">{d.job.sender.senderName} &lt;{d.job.sender.senderEmail}&gt;</dd></div>
            <div><dt className="text-xs text-muted">Template</dt><dd>{d.job.template ? `${d.job.template.name} (v${d.job.template.version})` : "—"}</dd></div>
            <div><dt className="text-xs text-muted">Totals</dt><dd>{d.job.totals.sent} sent · {d.job.totals.failed} failed · {d.job.totals.skipped} skipped</dd></div>
            <div><dt className="text-xs text-muted">Created</dt><dd>{fmtDate(d.job.createdAt)}</dd></div>
            <div><dt className="text-xs text-muted">Finished</dt><dd>{fmtDate(d.job.finishedAt)}</dd></div>
            {d.job.retryOf && <div className="sm:col-span-2"><dt className="text-xs text-muted">Retry of</dt><dd className="break-all">{d.job.retryOf}</dd></div>}
          </dl>
          <ul className="mt-4 max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {d.recipients.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-2 px-3 py-2 text-sm"><StatusBadge status={r.status} />
                <span className="min-w-0 flex-1 break-words">{r.recipient.Name} &lt;{r.recipient.Email}&gt;
                  {r.error && <span className="block text-xs text-muted">{r.error.message}{r.error.retryable && !r.retried ? " (can retry)" : ""}{r.retried ? " (retried)" : ""}</span>}
                  {r.providerMessageId && <span className="block text-xs text-muted">Accepted by provider · id {r.providerMessageId}</span>}</span></li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
