import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, download } from "../api";
import { useAuth } from "../auth";
import { ErrorAlert, Modal, fmtDate, useLoad } from "../components/common";
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Skeleton, Textarea, useToast } from "../components/ui";
import type { Profile } from "../types";

type Form = Pick<Profile, "name" | "phone" | "headline" | "skillsSummary" | "resumeUrl" | "linkedinUrl" | "location" | "targetRoles" | "noticePeriod"> & { experienceYears: string };
const toForm = (p: Profile): Form => ({ ...p, experienceYears: p.experienceYears === null ? "" : String(p.experienceYears) });

export function ProfilePage() {
  const { user, hasPassword, refresh, logout, setCsrfToken } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api.profile().then((r) => r.profile), []);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delConfirm, setDelConfirm] = useState("");
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<ApiError | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const f = form ?? (data ? toForm(data) : null);

  if (!f || !data) return <><PageHeader title="Profile" />{loading ? <Skeleton className="h-96" /> : <ErrorAlert error={error} onRetry={reload} />}</>;
  const set = (k: keyof Form, v: string) => setForm({ ...f, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault(); setSaving(true); setSaveError(null);
    try {
      await api.saveProfile({ ...f!, experienceYears: f!.experienceYears === "" ? null : Number(f!.experienceYears) });
      await reload(); await refresh(); setForm(null); toast("success", "Profile saved.");
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  }
  async function photo(fn: () => Promise<unknown>) {
    setSaveError(null);
    try { await fn(); await reload(); await refresh(); toast("success", "Photo updated."); } catch (err) { setSaveError(err); }
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault(); setPwBusy(true); setPwError(null);
    try {
      const r = await api.changePassword({ ...(hasPassword ? { currentPassword: pw.current } : {}), newPassword: pw.next });
      setCsrfToken(r.csrfToken); setPw({ current: "", next: "" }); await refresh();
      toast("success", "Password updated. Other devices were signed out.");
    } catch (err) { setPwError(err as ApiError); } finally { setPwBusy(false); }
  }
  async function removeAccount() {
    try { await api.deleteAccount(hasPassword ? { password: delConfirm } : { confirmEmail: delConfirm }); await logout().catch(() => undefined); nav("/login"); }
    catch (e) { setSaveError(e); setDelOpen(false); }
  }

  return (
    <>
      <PageHeader title="Profile" description={<>These details fill placeholders such as <code>{"{{SENDER_NAME}}"}</code>, <code>{"{{CONTACT_NO}}"}</code> and <code>{"{{HEADLINE}}"}</code>. Only your name was required at sign-up.</>} />
      <ErrorAlert error={saveError} />
      <div className="space-y-6">
        <Card className="flex flex-wrap items-center gap-5 p-5">
          {data.profilePhotoUrl ? <img className="size-24 rounded-full object-cover ring-2 ring-border" src={data.profilePhotoUrl} alt="Your profile" /> : <span className="grid size-24 place-items-center rounded-full bg-primary text-3xl font-semibold text-primary-foreground" aria-hidden>{data.name[0]?.toUpperCase()}</span>}
          <div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Choose profile photo" onChange={(e) => { const x = e.target.files?.[0]; if (x) void photo(() => api.uploadPhoto(x)); e.target.value = ""; }} />
            <div className="flex gap-2"><Button onClick={() => file.current?.click()}>{data.profilePhotoUrl ? "Change photo" : "Upload photo"}</Button>{data.profilePhotoUrl && <Button variant="ghost" onClick={() => photo(() => api.removePhoto())}>Remove</Button>}</div>
            <p className="mt-2 text-xs text-muted">PNG, JPEG or WebP, up to 2 MB. Optional.</p>
          </div>
        </Card>

        <Card>
          <CardHeader title="Personal details" />
          <form className="grid gap-4 p-5 sm:grid-cols-2" onSubmit={submit}>
            <Field label="Name">{(a) => <Input {...a} required value={f.name} maxLength={100} onChange={(e) => set("name", e.target.value)} />}</Field>
            <Field label={<span className="flex items-center gap-2">Login email {user?.emailVerified && <Badge tone="success">✓ Verified</Badge>}</span>} hint="Used to sign in. Your sending email is set separately.">{(a) => <Input {...a} value={data.loginEmail} readOnly />}</Field>
            <Field label="Phone / contact number">{(a) => <Input {...a} value={f.phone} inputMode="tel" maxLength={40} onChange={(e) => set("phone", e.target.value)} />}</Field>
            <Field label="Professional headline">{(a) => <Input {...a} value={f.headline} maxLength={160} placeholder="e.g. a Frontend Lead with 10+ years of experience" onChange={(e) => set("headline", e.target.value)} />}</Field>
            <Field label="Years of experience">{(a) => <Input {...a} type="number" min={0} max={70} value={f.experienceYears} onChange={(e) => set("experienceYears", e.target.value)} />}</Field>
            <Field label="Location">{(a) => <Input {...a} value={f.location} maxLength={120} onChange={(e) => set("location", e.target.value)} />}</Field>
            <Field label="Resume URL">{(a) => <Input {...a} type="url" value={f.resumeUrl} maxLength={500} placeholder="https://…" onChange={(e) => set("resumeUrl", e.target.value)} />}</Field>
            <Field label="LinkedIn URL">{(a) => <Input {...a} type="url" value={f.linkedinUrl} maxLength={500} placeholder="https://linkedin.com/in/…" onChange={(e) => set("linkedinUrl", e.target.value)} />}</Field>
            <Field label="Target roles">{(a) => <Input {...a} value={f.targetRoles} maxLength={300} onChange={(e) => set("targetRoles", e.target.value)} />}</Field>
            <Field label="Notice period / availability">{(a) => <Input {...a} value={f.noticePeriod} maxLength={120} onChange={(e) => set("noticePeriod", e.target.value)} />}</Field>
            <Field className="sm:col-span-2" label="Skills / summary">{(a) => <Textarea {...a} rows={5} value={f.skillsSummary} maxLength={2000} onChange={(e) => set("skillsSummary", e.target.value)} />}</Field>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2"><Button type="submit" variant="primary" loading={saving}>Save profile</Button><span className="text-xs text-muted">Last updated {fmtDate(data.updatedAt)}</span></div>
          </form>
        </Card>

        <Card>
          <CardHeader title="Security" description={user?.googleLinked ? "Google sign-in is linked to this account." : "Sign-in methods for this account."} />
          <form className="grid gap-4 p-5 sm:max-w-xl" onSubmit={changePassword}>
            {pwError && <ErrorAlert error={pwError} />}
            {hasPassword && <Field label="Current password">{(a) => <Input {...a} type="password" required value={pw.current} autoComplete="current-password" onChange={(e) => setPw({ ...pw, current: e.target.value })} />}</Field>}
            <Field label={hasPassword ? "New password" : "Set a password (optional)"} hint="At least 10 characters with a letter and a number. Changing it signs out your other devices.">
              {(a) => <Input {...a} type="password" required value={pw.next} autoComplete="new-password" onChange={(e) => setPw({ ...pw, next: e.target.value })} />}
            </Field>
            <div><Button type="submit" loading={pwBusy}>{hasPassword ? "Change password" : "Set password"}</Button></div>
          </form>
        </Card>

        <Card>
          <CardHeader title="Account" description={`Created ${fmtDate(data.createdAt)}. You own your data: export it or delete it permanently.`} />
          <div className="flex flex-wrap gap-2 p-5">
            <Button onClick={async () => { try { download(await api.exportAccount(), "jobhunting-account-export.json"); } catch (e) { setSaveError(e); } }}>Export my data (JSON)</Button>
            <Button variant="danger" onClick={() => setDelOpen(true)}>Delete account…</Button>
          </div>
        </Card>
      </div>
      {delOpen && (
        <Modal title="Delete account" onClose={() => setDelOpen(false)} footer={<>
          <Button onClick={() => setDelOpen(false)}>Cancel</Button>
          <Button variant="danger" disabled={!delConfirm} onClick={removeAccount}>Delete everything</Button>
        </>}>
          <p className="mb-4 text-sm">This permanently deletes your profile, contacts, imports, templates, sender credentials, jobs and email history. It cannot be undone.</p>
          <Field label={hasPassword ? "Confirm your password" : `Type your email (${user?.email}) to confirm`}>{(a) => <Input {...a} type={hasPassword ? "password" : "email"} value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} autoComplete={hasPassword ? "current-password" : "off"} />}</Field>
        </Modal>
      )}
    </>
  );
}
