import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type { AccountStatus, AdminUser, AdminUserDetail, AuditItem, Role, SmtpSettings } from "../types";
import { Alert, ErrorAlert, Modal, Pagination, fmtDate } from "../components/common";
import { useConfirm } from "../components/confirm";
import { UsersIcon } from "../components/icons";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, SkeletonRows, cn, tableClasses as t, useToast } from "../components/ui";

type Tab = "candidates" | "audit" | "email";

const roleBadge = (u: Pick<AdminUser, "role" | "isOwner">) => <Badge tone={u.isOwner ? "primary" : u.role === "admin" ? "info" : "neutral"}>{u.isOwner ? "Owner" : u.role === "admin" ? "Admin" : "Candidate"}</Badge>;
const statusBadge = (s: AccountStatus) => <Badge tone={s === "active" ? "success" : "danger"}>{s === "active" ? "✓ Active" : "⏸ Suspended"}</Badge>;

export function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("candidates");
  const tabs: [Tab, string][] = [["candidates", "Candidates"], ["audit", "Audit log"], ...(user?.isOwner ? [["email", "Email delivery"] as [Tab, string]] : [])];
  return (
    <>
      <PageHeader title="Admin" description={user?.isOwner ? "You are the application owner: you can manage Admins and email delivery." : "Manage candidate accounts. Only the owner can promote Admins or change email delivery."} />
      <div role="tablist" aria-label="Admin sections" className="mb-5 flex gap-1 border-b border-border">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn("-mb-px min-h-11 border-b-2 px-4 text-sm font-medium", tab === k ? "border-primary text-primary" : "border-transparent text-muted hover:text-foreground")}>{label}</button>
        ))}
      </div>
      {tab === "candidates" && <Candidates />}
      {tab === "audit" && <Audit />}
      {tab === "email" && user?.isOwner && <EmailDelivery />}
    </>
  );
}

/* ------------------------------------------------------------- candidates */
function Candidates() {
  const [f, setF] = useState({ q: "", role: "", status: "", sort: "createdAt", order: "desc", page: 1 });
  const [q, setQ] = useState("");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminUsers>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api.adminUsers({ ...f, pageSize: 20 })); } catch (e) { setError(e); } finally { setLoading(false); }
  }, [f]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const x = setTimeout(() => setF((s) => (s.q === q ? s : { ...s, q, page: 1 })), 300); return () => clearTimeout(x); }, [q]);
  const filtered = !!(f.q || f.role || f.status);

  return (
    <>
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4" role="search">
        <Field className="sm:col-span-2" label="Search">{(a) => <Input {...a} type="search" value={q} placeholder="Name or email" onChange={(e) => setQ(e.target.value)} />}</Field>
        <Field label="Role">{(a) => <Select {...a} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, page: 1 })}><option value="">All roles</option><option value="candidate">Candidate</option><option value="admin">Admin</option></Select>}</Field>
        <Field label="Status">{(a) => <Select {...a} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></Select>}</Field>
        <Field className="sm:col-span-2 lg:col-span-4" label="Sort">{(a) => <Select {...a} value={`${f.sort}:${f.order}`} onChange={(e) => { const [sort, order] = e.target.value.split(":"); setF({ ...f, sort, order, page: 1 }); }}>
          <option value="createdAt:desc">Newest registrations</option><option value="createdAt:asc">Oldest registrations</option><option value="name:asc">Name A–Z</option><option value="email:asc">Email A–Z</option><option value="lastLoginAt:desc">Most recent sign-in</option></Select>}</Field>
      </Card>
      <ErrorAlert error={error} onRetry={load} />
      <Card className="mt-4 overflow-hidden">
        {loading && !data ? <SkeletonRows /> : data && data.items.length === 0 ? (
          <EmptyState icon={<UsersIcon />} title={filtered ? "No accounts match these filters" : "No accounts yet"} description={filtered ? "Try clearing a filter." : undefined} />
        ) : data && (
          <div className={t.wrap} tabIndex={0} aria-label="Candidate accounts">
            <table className={t.table}>
              <thead className={t.thead}><tr>{["Name", "Email", "Role", "Status", "Registered", "Last sign-in", ""].map((h, i) => <th key={i} className={t.th}>{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
              <tbody className={t.tbody}>
                {data.items.map((u) => (
                  <tr key={u.id} className={t.tr}>
                    <td data-label="Name" className={cn(t.td, "font-medium")}>{u.name}</td>
                    <td data-label="Email" className={cn(t.td, "break-all")}>{u.email}{!u.emailVerified && <span className="block text-xs text-warning">unverified</span>}</td>
                    <td data-label="Role" className={t.td}>{roleBadge(u)}</td>
                    <td data-label="Status" className={t.td}>{statusBadge(u.status)}</td>
                    <td data-label="Registered" className={t.td}>{fmtDate(u.createdAt)}</td>
                    <td data-label="Last sign-in" className={t.td}>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : <span className="text-muted">Never recorded</span>}</td>
                    <td className={t.td}><Button size="sm" onClick={() => setOpen(u.id)} aria-label={`Manage ${u.name}`}>Manage</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data && data.total > 0 && <div className="mt-4"><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setF({ ...f, page })} /></div>}
      {open && <UserModal id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function UserModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { user: me } = useAuth();
  const [d, setD] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const refresh = useCallback(async () => { try { setD(await api.adminUser(id)); } catch (e) { setError(e); } }, [id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const u = d?.user;
  const isSelf = !!u && u.id === me?.id;
  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null);
    try { await fn(); toast("success", ok); await refresh(); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function setRole(role: Role) {
    if (!u) return;
    const promote = role === "admin";
    if (!(await confirm({
      title: promote ? `Make ${u.name} an Admin?` : `Remove Admin access from ${u.name}?`,
      message: promote ? <>Admins can view every candidate account and suspend candidates. This grants <strong>{u.email}</strong> that access immediately and is recorded in the audit log.</> : <><strong>{u.email}</strong> will lose Admin access immediately. This is recorded in the audit log.</>,
      confirmLabel: promote ? "Make Admin" : "Remove Admin", cancelLabel: "Cancel", tone: promote ? "default" : "danger",
    }))) return;
    await act(() => api.setRole(u.id, role), promote ? "Promoted to Admin." : "Admin access removed.");
  }
  async function setStatus(status: AccountStatus) {
    if (!u) return;
    const suspend = status === "suspended";
    if (!(await confirm({
      title: suspend ? `Suspend ${u.name}?` : `Reactivate ${u.name}?`,
      message: suspend ? <>They will be signed out everywhere and cannot sign in until reactivated. Their data is kept.</> : <>They will be able to sign in again.</>,
      confirmLabel: suspend ? "Suspend account" : "Reactivate", tone: suspend ? "danger" : "default",
    }))) return;
    await act(() => api.setStatus(u.id, status), suspend ? "Account suspended." : "Account reactivated.");
  }

  // Buttons mirror the backend rules for usability only; the API enforces them regardless.
  const canRole = !!me?.isOwner && !!u && !u.isOwner && !isSelf;
  const canStatus = !!u && !u.isOwner && !isSelf && (u.role !== "admin" || !!me?.isOwner);
  return (
    <Modal title="Account details" size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      <ErrorAlert error={error} />
      {!d || !u ? (error ? null : <SkeletonRows rows={4} />) : (
        <>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Name</dt><dd className="font-medium">{u.name}</dd></div>
            <div><dt className="text-xs text-muted">Email</dt><dd className="break-all">{u.email} {u.emailVerified ? <Badge tone="success">verified</Badge> : <Badge tone="warning">unverified</Badge>}</dd></div>
            <div><dt className="text-xs text-muted">Role</dt><dd className="mt-0.5">{roleBadge(u)}</dd></div>
            <div><dt className="text-xs text-muted">Status</dt><dd className="mt-0.5">{statusBadge(u.status)}</dd></div>
            <div><dt className="text-xs text-muted">Registered</dt><dd>{fmtDate(u.createdAt)}</dd></div>
            <div><dt className="text-xs text-muted">Last sign-in</dt><dd>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : "Not recorded"}</dd></div>
            <div><dt className="text-xs text-muted">Sign-in methods</dt><dd>{[u.hasPassword && "Password", u.googleLinked && "Google", u.emailVerified && "Email code"].filter(Boolean).join(", ") || "—"}</dd></div>
            <div><dt className="text-xs text-muted">Sending account</dt><dd>{u.senderStatus.replace("_", " ")}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted">Usage (counts only)</dt><dd>{d.usage.contacts} recruiters · {d.usage.templates} templates · {d.usage.jobs} jobs · {d.usage.emailsSent} emails sent</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted">Passwords, codes, tokens, mail credentials and a candidate's contacts or messages are never shown to Admins.</p>
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
            {u.role === "candidate"
              ? <Button variant="primary" disabled={busy || !canRole || !u.emailVerified || u.status === "suspended"} onClick={() => setRole("admin")}>Make Admin</Button>
              : <Button variant="danger" disabled={busy || !canRole} onClick={() => setRole("candidate")}>Remove Admin</Button>}
            {u.status === "active"
              ? <Button variant="danger" disabled={busy || !canStatus} onClick={() => setStatus("suspended")}>Suspend</Button>
              : <Button disabled={busy || !canStatus} onClick={() => setStatus("active")}>Reactivate</Button>}
          </div>
          {u.isOwner && <p className="mt-2 text-xs text-muted">The owner account is protected: its role and status can't be changed here.</p>}
          {isSelf && !u.isOwner && <p className="mt-2 text-xs text-muted">You can't change your own role or status.</p>}
          {!me?.isOwner && !u.isOwner && <p className="mt-2 text-xs text-muted">Only the owner can promote or demote Admins{u.role === "admin" ? " or change an Admin's status" : ""}.</p>}
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------- audit */
const ACTIONS: Record<string, string> = {
  "role.promote": "Promoted to Admin", "role.demote": "Admin access removed", "account.suspend": "Account suspended", "account.reactivate": "Account reactivated",
  "owner.bootstrap": "Owner account initialised", "settings.email.update": "Email delivery settings saved", "settings.email.clear": "Email delivery settings cleared", "settings.email.test": "Email delivery tested",
};
function Audit() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: AuditItem[]; total: number; page: number; pageSize: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => { setError(null); try { setData(await api.adminAudit({ page, pageSize: 20 })); } catch (e) { setError(e); } }, [page]);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <ErrorAlert error={error} onRetry={load} />
      <Card className="overflow-hidden">
        <CardHeader title="Audit log" description="Role changes, account actions and settings changes. Secrets are never recorded." />
        {!data ? (error ? null : <SkeletonRows />) : data.items.length === 0 ? <EmptyState title="Nothing recorded yet" /> : (
          <ul className="divide-y divide-border">
            {data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3 text-sm">
                <span><span className="font-medium">{ACTIONS[a.action] ?? a.action}</span>{a.targetEmail && <> · <span className="break-all">{a.targetEmail}</span></>}{a.actorEmail && <span className="text-muted"> · by {a.actorEmail}</span>}</span>
                <time className="text-xs text-muted" dateTime={a.createdAt}>{fmtDate(a.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {data && data.total > 0 && <div className="mt-4"><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>}
    </>
  );
}

/* ------------------------------------------------------- email delivery (owner) */
function EmailDelivery() {
  const [s, setS] = useState<SmtpSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ host: "", port: "465", secure: true, user: "", from: "", pass: "" });
  const [busy, setBusy] = useState<"" | "save" | "test" | "clear">("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const adopt = (x: SmtpSettings) => { setS(x); setForm({ host: x.host, port: String(x.port), secure: x.secure, user: x.user, from: x.from, pass: "" }); };
  useEffect(() => { api.smtpSettings().then((r) => adopt(r.settings)).catch(setError); }, []);

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy("save"); setError(null); setResult(null);
    try { adopt((await api.saveSmtp({ host: form.host, port: Number(form.port), secure: form.secure, user: form.user, from: form.from, ...(form.pass ? { pass: form.pass } : {}) })).settings); toast("success", "Saved. Run the test to confirm delivery works."); }
    catch (x) { setError(x); } finally { setBusy(""); }
  }
  async function test() {
    setBusy("test"); setError(null); setResult(null);
    try { const r = await api.testSmtp(); adopt(r.settings); setResult({ ok: r.ok, message: r.message }); } catch (x) { setError(x); } finally { setBusy(""); }
  }
  async function clear() {
    if (!(await confirm({ title: "Remove stored email settings?", message: "The saved credentials are deleted. Sign-in codes will fall back to the server environment settings, or stop working if none exist.", confirmLabel: "Remove settings", tone: "danger" }))) return;
    setBusy("clear"); setError(null); setResult(null);
    try { adopt((await api.clearSmtp()).settings); toast("success", "Stored settings removed."); } catch (x) { setError(x); } finally { setBusy(""); }
  }

  if (!s) return error ? <ErrorAlert error={error} /> : <SkeletonRows rows={4} />;
  return (
    <>
      {!s.configured && <Alert kind="warn"><p><strong>Email delivery isn't configured.</strong> Sign-in codes can't be sent, so email-code login and registration are unavailable to everyone. Fill in the form below (or set <code>AUTH_SMTP_*</code> in the server environment), then run the test.</p></Alert>}
      {s.source === "environment" && <Alert kind="info"><p>Currently using the server environment (<code>AUTH_SMTP_*</code>). Saving here overrides it.</p></Alert>}
      <ErrorAlert error={error} />
      {result && <Alert kind={result.ok ? "ok" : "error"}><p>{result.message}</p></Alert>}
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="SMTP provider" description="Used for sign-in codes and other messages the app sends from its own verified sender." />
          <form className="space-y-4 p-5" onSubmit={save}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field className="sm:col-span-2" label="SMTP host">{(a) => <Input {...a} required value={form.host} placeholder="smtp.resend.com" onChange={(e) => setForm({ ...form, host: e.target.value })} />}</Field>
              <Field label="Port">{(a) => <Input {...a} required type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />}</Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={form.secure} onChange={(e) => setForm({ ...form, secure: e.target.checked })} />Use implicit TLS (port 465). Untick for STARTTLS on 587.</label>
            <Field label="Username">{(a) => <Input {...a} required autoComplete="off" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />}</Field>
            <Field label="Password / API key / App Password" hint="Encrypted on the server. It is never shown again or sent back to your browser.">
              {(a) => <Input {...a} type="password" autoComplete="new-password" required={!s.hasPassword || s.source !== "database"} value={form.pass} placeholder={s.source === "database" ? "Saved. Leave blank to keep it" : ""} onChange={(e) => setForm({ ...form, pass: e.target.value })} />}
            </Field>
            <Field label="From address" hint="Must be a sender or domain verified with your provider, e.g. JobHunting <no-reply@your-domain.com>.">{(a) => <Input {...a} required value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={busy === "save"} disabled={!!busy}>Save</Button>
              <Button disabled={!!busy || !s.configured} loading={busy === "test"} onClick={test}>Send test email to me</Button>
              {s.source === "database" && <Button variant="danger" disabled={!!busy} loading={busy === "clear"} onClick={clear}>Remove stored settings</Button>}
            </div>
          </form>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Status" />
          <dl className="space-y-3 p-5 text-sm">
            <div><dt className="text-xs font-medium uppercase tracking-wide text-muted">Source</dt><dd className="mt-0.5">{s.source === "database" ? "Saved in Admin settings (encrypted)" : s.source === "environment" ? "Server environment" : "None"}</dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-muted">Last test</dt><dd className="mt-0.5">{s.lastTest ? <><Badge tone={s.lastTest.ok ? "success" : "danger"}>{s.lastTest.ok ? "✓ Passed" : "✕ Failed"}</Badge><span className="mt-1 block text-xs text-muted">{fmtDate(s.lastTest.at)} · {s.lastTest.message}</span></> : "Not tested yet"}</dd></div>
          </dl>
          <p className="border-t border-border p-5 text-xs text-muted">Recommended for a public app: a transactional provider (Resend, Amazon SES, Postmark, SendGrid) with a verified sending domain. A personal Gmail App Password works for testing but has low daily limits and is not suited to a public launch.</p>
        </Card>
      </div>
    </>
  );
}
