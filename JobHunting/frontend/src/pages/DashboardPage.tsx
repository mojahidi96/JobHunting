import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorAlert, StatusBadge, fmtDate, useLoad } from "../components/common";
import { CheckIcon } from "../components/icons";
import { TemplateEditor } from "../components/TemplateEditor";
import { Button, Card, CardHeader, EmptyState, PageHeader, Skeleton, Stat, cn } from "../components/ui";

export function DashboardPage() {
  const { data, error, loading, reload } = useLoad(async () => {
    const [contacts, templates, hist, sender, profile, jobs] = await Promise.all([
      api.contacts({ pageSize: 1 }), api.templates(), api.history({ pageSize: 1 }), api.senderSettings(), api.profile(), api.jobs(),
    ]);
    return { contacts, templates, hist, sender: sender.settings, profile: profile.profile, jobs: jobs.items.slice(0, 5) };
  }, []);
  const [editing, setEditing] = useState(false);

  if (!data) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorAlert error={error} onRetry={reload} />
        {loading && <div role="status" aria-live="polite" className="space-y-4"><span className="sr-only">Loading dashboard…</span>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div><Skeleton className="h-48" /></div>}
      </>
    );
  }
  const def = data.templates.items.find((t) => t.isDefault) ?? data.templates.items[0];
  const steps = [
    { done: !!(data.profile.phone && data.profile.headline && data.profile.resumeUrl), label: "Complete your profile", hint: "Phone, headline and resume link fill your email template.", to: "/profile" },
    { done: data.sender.status === "verified", label: "Connect and verify your sending email", hint: "Use a Gmail App Password. Nothing is sent during the test.", to: "/settings/email" },
    { done: data.templates.items.some((t) => t.reviewed), label: "Personalise and review your email template", hint: "You confirm the template before the first real send.", to: "" },
    { done: data.contacts.total > 0, label: "Add or import recruiter contacts", hint: "Manually, or from an .xlsx / .json file.", to: "/recruiters" },
    { done: data.hist.counts.attempted > 0, label: "Send your first reviewed batch", hint: "Select recruiters, preview, then confirm.", to: "/recruiters" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const c = data.hist.counts;
  return (
    <>
      <PageHeader title="Dashboard" description="Your outreach at a glance."
        actions={<Button variant="primary" size="lg" onClick={() => setEditing(true)} disabled={!def}>Update Email Template</Button>} />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Recruiters" value={data.contacts.total} />
        <Stat label="Attempted" value={c.attempted} />
        <Stat label="Sent" value={c.sent} tone="success" hint="Accepted by provider" />
        <Stat label="Failed" value={c.failed} tone={c.failed ? "danger" : "neutral"} />
        <Stat label="Skipped" value={c.skipped} />
      </div>
      <p className="mt-2 text-xs text-muted">“Sent” means accepted by your email provider, not guaranteed inbox delivery.</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Get started" description={`${doneCount} of ${steps.length} steps complete`} />
          <div className="h-1.5 bg-surface-muted"><div className="h-full bg-primary transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
          <ol className="divide-y divide-border">
            {steps.map((s, i) => (
              <li key={s.label} className="flex items-start gap-3 px-5 py-3.5">
                <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold", s.done ? "bg-success-soft text-success" : "bg-surface-muted text-muted")} aria-hidden>{s.done ? <CheckIcon className="size-3.5" /> : i + 1}</span>
                <div className="min-w-0 flex-1">
                  {s.to ? <Link to={s.to} className="font-medium hover:text-primary hover:underline">{s.label}</Link> : <button type="button" className="font-medium hover:text-primary hover:underline" onClick={() => setEditing(true)}>{s.label}</button>}
                  <p className="text-sm text-muted">{s.hint}</p>
                  <span className="sr-only">{s.done ? "Done" : "To do"}</span>
                </div>
              </li>
            ))}
          </ol>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Recent jobs" actions={<Link to="/history" className="text-sm font-medium text-primary hover:underline">All history</Link>} />
          {data.jobs.length === 0 ? <EmptyState title="No emails sent yet" description="Nothing is ever sent without your confirmation." /> : (
            <ul className="divide-y divide-border">
              {data.jobs.map((j) => (
                <li key={j.jobId} className="flex flex-col gap-1 px-5 py-3"><div className="flex items-center justify-between gap-2"><StatusBadge status={j.status} /><span className="text-xs text-muted">{fmtDate(j.createdAt)}</span></div>
                  <p className="text-sm text-muted">{j.totals.sent} sent · {j.totals.failed} failed · {j.totals.skipped} skipped</p></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {editing && def && <TemplateEditor template={def} onSaved={() => void reload()} onClose={() => { setEditing(false); void reload(); }} />}
    </>
  );
}
