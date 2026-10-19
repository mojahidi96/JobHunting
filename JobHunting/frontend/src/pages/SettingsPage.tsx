import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, apiUrl } from "../api";
import { Alert, ErrorAlert, StatusBadge, fmtDate, useLoad } from "../components/common";
import { useConfirm } from "../components/confirm";
import { Button, Card, CardHeader, Field, Input, PageHeader, Skeleton, useToast } from "../components/ui";
import type { SenderSettings } from "../types";

const GMAIL_RESULT: Record<string, [("ok" | "error" | "warn"), string]> = {
  connected: ["ok", "Gmail connected. Your messages will be sent from your own mailbox."],
  denied: ["warn", "Connection cancelled. Nothing was changed."],
  scope_missing: ["error", "Google didn't grant permission to send email. Try again and leave the “Send email on your behalf” box ticked."],
  no_refresh: ["error", "Google didn't return a long-lived grant. Remove JobHunting at myaccount.google.com/permissions, then connect again."],
  job_active: ["warn", "An email job is running. Try again when it finishes."],
  unverified: ["error", "That Google account's email isn't verified."],
  unavailable: ["error", "Gmail connection isn't available on this server."],
  failed: ["error", "Couldn't connect Gmail. Please try again."],
};

export function SettingsPage() {
  const [params] = useSearchParams();
  const gmailResult = GMAIL_RESULT[params.get("gmail") ?? ""];
  const { data, error, loading, reload, setData } = useLoad(() => api.senderSettings().then((r) => r.settings), []);
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  const confirm = useConfirm();

  if (!data) return <><PageHeader title="Email Sending Settings" />{loading ? <Skeleton className="h-64" /> : <ErrorAlert error={error} onRetry={reload} />}</>;
  const n = name ?? data.senderName, e = email ?? data.senderEmail;
  const oauth = data.provider === "gmail_oauth" && data.hasCredential;
  const showAppPassword = !!data.appPasswordAllowed || (data.provider === "gmail_smtp" && data.hasCredential);

  async function run(kind: "save" | "test" | "remove", fn: () => Promise<{ settings: SenderSettings }>, ok: string) {
    setBusy(kind); setErr(null);
    try { const r = await fn(); setData(r.settings); setName(null); setEmail(null); setPass(""); toast(r.settings.status === "failed" ? "error" : "success", r.settings.status === "failed" && kind === "test" ? "Connection test failed. See the details below." : ok); }
    catch (x) { setErr(x); } finally { setBusy(""); }
  }
  const save = (ev: FormEvent) => { ev.preventDefault(); void run("save", () => api.saveSender({ senderName: n, senderEmail: e, ...(pass ? { appPassword: pass } : {}) }), "Saved. Run the connection test to verify this account."); };

  return (
    <>
      <PageHeader title="Email Sending Settings" description="The account recruiter emails are sent from. It is separate from the email you sign in with." />
      {gmailResult && <Alert kind={gmailResult[0]}><p>{gmailResult[1]}</p></Alert>}
      <Alert kind="info">
        <p>Signing in to JobHunting does <strong>not</strong> let it send from your mailbox. <strong>Sign-in codes and account messages</strong> come from JobHunting's own verified sender. <strong>Recruiter emails</strong> are sent from <strong>your</strong> mailbox, only after you connect it here, and JobHunting never sees your Google password.</p>
      </Alert>
      <ErrorAlert error={err} />
      <div className="mt-4 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Current status" />
          <dl className="space-y-3 p-5 text-sm">
            <div><dt className="text-xs font-medium uppercase tracking-wide text-muted">Login email</dt><dd className="mt-0.5 break-all">{data.loginEmail}</dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-muted">Sending identity</dt><dd className="mt-0.5 break-all">{data.senderEmail ? `${data.senderName} <${data.senderEmail}>` : "—"}</dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-muted">Status</dt><dd className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge status={data.status} kind="sender" />{data.verifiedAt && <span className="text-xs text-muted">verified {fmtDate(data.verifiedAt)}</span>}</dd></div>
            {data.lastError && <div><dt className="text-xs font-medium uppercase tracking-wide text-muted">Last error</dt><dd className="mt-0.5 text-danger">{data.lastError}</dd></div>}
          </dl>
        </Card>
        <div className="space-y-6 lg:col-span-3">
        <Card>
          <CardHeader title="Connect Gmail" description="Recommended. Sign in with Google and approve send-only access." />
          <div className="space-y-4 p-5 text-sm">
            {data.gmailOAuthAvailable ? (
              <>
                <p className="text-muted">Google shows exactly what you're allowing: JobHunting can <strong>send</strong> email as you. It can't read, search or delete your mail. You can revoke access any time at myaccount.google.com/permissions.</p>
                {oauth && (
                  <form className="flex flex-wrap items-end gap-3" onSubmit={(ev) => { ev.preventDefault(); void run("save", () => api.saveSenderName(n), "Sender name saved."); }}>
                    <Field className="min-w-48 flex-1" label="Sender name">{(a) => <Input {...a} required value={n} maxLength={100} onChange={(x) => setName(x.target.value)} />}</Field>
                    <Button type="submit" disabled={!!busy || n === data.senderName} loading={busy === "save"}>Save name</Button>
                  </form>
                )}
                <div className="flex flex-wrap gap-2">
                  <a href={apiUrl("/settings/email/gmail/connect")} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary-hover max-sm:min-h-11">{oauth ? "Reconnect Gmail" : "Connect Gmail"}</a>
                  {oauth && <Button variant="danger" disabled={!!busy} onClick={async () => { if (await confirm({ title: "Disconnect Gmail?", message: "JobHunting will revoke its access to your mailbox. You'll need to connect again before sending.", confirmLabel: "Disconnect", tone: "danger" })) void run("remove", api.removeSender, "Gmail disconnected."); }}>Disconnect</Button>}
                </div>
              </>
            ) : <Alert kind="warn"><p>Gmail connection isn't set up on this server yet, so sending isn't available. The administrator needs to configure Google sign-in.</p></Alert>}
          </div>
        </Card>
        {showAppPassword && <Card>
          <CardHeader title="Advanced: Gmail App Password" description="Not recommended. Only for self-hosted setups that enable it." />
          <form className="space-y-4 p-5" onSubmit={save}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Sender name">{(a) => <Input {...a} required value={n} maxLength={100} onChange={(x) => setName(x.target.value)} />}</Field>
              <Field label="Sending email address">{(a) => <Input {...a} required type="email" value={e} onChange={(x) => setEmail(x.target.value)} />}</Field>
            </div>
            <Field label="Gmail App Password" hint="Stored encrypted on the server. It is never shown again or kept in your browser.">
              {(a) => <Input {...a} type="password" value={pass} autoComplete="new-password" placeholder={data.hasCredential ? "Saved. Leave blank to keep it" : "16-character app password"} onChange={(x) => setPass(x.target.value)} required={!data.hasCredential} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={busy === "save"} disabled={!!busy}>Save</Button>
              <Button disabled={!!busy || !data.hasCredential} loading={busy === "test"} onClick={() => run("test", api.testSender, "Connection verified.")}>Test connection</Button>
              {data.hasCredential && <Button variant="danger" disabled={!!busy} onClick={async () => { if (await confirm({ title: "Remove sending account?", message: "The saved sender address and app password will be deleted. You will need to set them up again before sending.", confirmLabel: "Remove", tone: "danger" })) void run("remove", api.removeSender, "Sender removed."); }}>Remove</Button>}
            </div>
            <p className="text-xs text-muted">The connection test only signs in to check the credentials. It never sends an email. Saving changes marks the account unverified again.</p>
          </form>
        </Card>}
        </div>
      </div>
    </>
  );
}
