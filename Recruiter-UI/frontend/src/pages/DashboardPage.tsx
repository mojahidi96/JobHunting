import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmailPreview } from "../components/EmailPreview";
import { EmailTemplateEditor } from "../components/EmailTemplateEditor";
import { JobProgressPanel } from "../components/JobProgressPanel";
import { applyFilters, RecruiterFilters, type Filters } from "../components/RecruiterFilters";
import { RecruiterTable } from "../components/RecruiterTable";
import { SendConfirmationDialog } from "../components/SendConfirmationDialog";
import { DEFAULT_TEMPLATE } from "../defaultTemplate";
import { api } from "../services/api";
import type { EmailTemplate, JobResponse, PreviewItem, Recruiter, RecruitersResponse } from "../types/api";

const POLL_MS = 3000;
const TERMINAL = new Set(["completed", "completed_with_errors", "failed"]);
const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export function DashboardPage() {
  const [data, setData] = useState<RecruitersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ search: "", status: "all", isSend: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [template, setTemplate] = useState<EmailTemplate>(DEFAULT_TEMPLATE);

  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [previewActive, setPreviewActive] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const sendingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.recruiters();
      setData(res);
      const ids = new Set(res.items.map((r) => r.id));
      setSelected((s) => new Set([...s].filter((id) => ids.has(id))));
    } catch (e) {
      setLoadError(msg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const items = data?.items ?? [];
  const byId = useMemo(() => new Map<string, Recruiter>(items.map((r) => [r.id, r])), [items]);
  const visible = useMemo(() => applyFilters(items, filters), [items, filters]);
  const counts = useMemo(() => {
    const c = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of items) c[r.status]++;
    return c;
  }, [items]);

  const selectedIds = useMemo(() => items.filter((r) => selected.has(r.id)).map((r) => r.id), [items, selected]);
  const currentKey = JSON.stringify([selectedIds, template]);
  const previewStale = preview !== null && previewKey !== currentKey;

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const runPreview = async () => {
    if (selectedIds.length === 0) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await api.preview({ recruiterIds: selectedIds, template });
      setPreview(res.items);
      setPreviewKey(currentKey);
      setPreviewActive(res.items[0]?.recruiterId ?? null);
    } catch (e) {
      setPreviewError(msg(e));
    } finally {
      setPreviewing(false);
    }
  };

  const confirmSend = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const res = await api.send({
        recruiterIds: selectedIds,
        template,
        options: { delayMinMs: 45000, delayMaxMs: 90000, skipRowsMarkedNo: true },
        confirmation: true,
      });
      setConfirmOpen(false);
      setPollError(null);
      setJob(await api.job(res.jobId));
    } catch (e) {
      setConfirmOpen(false);
      setSendError(msg(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const jobId = job?.jobId;
  const jobDone = job ? TERMINAL.has(job.status) : true;
  useEffect(() => {
    if (!jobId || jobDone) return;
    const t = setInterval(async () => {
      try {
        setJob(await api.job(jobId));
        setPollError(null);
      } catch (e) {
        setPollError(msg(e));
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [jobId, jobDone]);

  useEffect(() => {
    if (jobId && jobDone) void load();
  }, [jobId, jobDone, load]);

  const jobActive = job !== null && !jobDone;
  const connected = data !== null && !loadError;

  return (
    <div className="page">
      <header className="header">
        <h1>Recruiter Outreach Mailer</h1>
        <div className="header-right">
          <span className={`conn ${connected ? "ok" : loadError ? "bad" : ""}`} role="status">
            {loading ? "Connecting…" : connected ? `● API connected · ${data!.source.fileName}` : "● API unavailable"}
          </span>
          <button type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
      </header>

      <main>
        <section className="cards" aria-label="Summary">
          {[["Total", items.length], ["Pending", counts.pending], ["Sent", counts.sent], ["Failed", counts.failed], ["Skipped", counts.skipped]].map(([l, n]) => (
            <div className="card" key={l as string}><div className="card-n">{n}</div><div className="muted">{l}</div></div>
          ))}
        </section>

        {loadError && (
          <div className="error" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {data?.warnings.map((w) => <p className="notice" key={w}>{w}</p>)}

        <section className="panel" aria-labelledby="rec-h">
          <h2 id="rec-h">Recruiters</h2>
          <RecruiterFilters filters={filters} onChange={setFilters} />
          {loading && !data ? (
            <p>Loading recruiters…</p>
          ) : data && items.length === 0 ? (
            <p>No recruiters found in the worksheet “{data.source.sheetName}”.</p>
          ) : data && visible.length === 0 ? (
            <p>No recruiters match the current filters.</p>
          ) : data ? (
            <RecruiterTable
              rows={visible}
              selected={selected}
              onToggle={toggle}
              onSelectVisible={() => setSelected((s) => new Set([...s, ...visible.map((r) => r.id)]))}
              onClear={() => setSelected(new Set())}
            />
          ) : null}
        </section>

        <EmailTemplateEditor template={template} onChange={setTemplate} onReset={() => setTemplate(DEFAULT_TEMPLATE)} />

        <section className="panel" aria-labelledby="act-h">
          <h2 id="act-h">Preview and send</h2>
          {selectedIds.length === 0 && <p className="notice" role="status">No recruiters selected. Select at least one to preview or send.</p>}
          <div className="toolbar">
            <button type="button" onClick={() => void runPreview()} disabled={selectedIds.length === 0 || previewing}>
              {previewing ? "Loading preview…" : "Preview email"}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => { setSendError(null); setConfirmOpen(true); }}
              disabled={selectedIds.length === 0 || sending || jobActive}
            >
              Send emails ({selectedIds.length})
            </button>
          </div>
          {previewError && <p className="error" role="alert">{previewError}</p>}
          {sendError && <p className="error" role="alert">Send failed: {sendError}</p>}
        </section>

        <EmailPreview items={preview} recruiters={byId} activeId={previewActive} onActiveChange={setPreviewActive} stale={previewStale} />
        {job && <JobProgressPanel job={job} recruiters={byId} pollError={pollError} />}
      </main>

      {confirmOpen && (
        <SendConfirmationDialog
          count={selectedIds.length}
          subject={template.subject}
          submitting={sending}
          onConfirm={() => void confirmSend()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
