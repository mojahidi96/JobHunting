import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api, apiUrl } from "../api";
import { useAuth } from "../auth";
import { Alert } from "../components/common";
import { CheckIcon, GoogleIcon, MailIcon } from "../components/icons";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { Button, Field, Input, cn } from "../components/ui";
import type { Providers } from "../types";
import { useLoad } from "../components/common";

const GOOGLE_ERRORS: Record<string, string> = {
  google_denied: "Google sign-in was cancelled. You can try again or use another method.",
  google_failed: "Google sign-in didn't complete. Please try again.",
  google_unverified: "Your Google email address isn't verified, so we can't use it to sign you in.",
  google_conflict: "This email is already linked to a different Google account.",
  google_unavailable: "Google sign-in isn't available right now.",
};

type Mode = "login" | "register" | "otp";

function Brand({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-card"><CheckIcon className="size-5" /></span>
      <span className="text-lg font-semibold tracking-tight">JobHunting</span>
    </div>
  );
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { login, register, otpVerify, notice, clearNotice } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const providers = useLoad<Providers>(() => api.providers(), []).data;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  // email OTP state
  const [step, setStep] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [sentInfo, setSentInfo] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);

  const urlError = GOOGLE_ERRORS[params.get("error") ?? ""] ?? null;
  useEffect(() => { setError(null); setStep("email"); setCode(""); setSentInfo(""); }, [mode]);
  useEffect(() => { if (cooldown <= 0) return; const t = setTimeout(() => setCooldown((c) => c - 1), 1000); return () => clearTimeout(t); }, [cooldown]);
  useEffect(() => { if (step === "code") codeRef.current?.focus(); }, [step]);

  const fieldErr = (field: string) => error?.code === "VALIDATION_ERROR" ? error.details.find((d) => d.startsWith(`${field}:`))?.replace(`${field}: `, "") : undefined;
  const done = (isNew: boolean) => nav(isNew ? "/onboarding" : "/", { replace: true });

  async function submitPassword(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = mode === "login" ? await login(email, password) : await register(name, email, password);
      done(r.isNewUser || !r.user.onboardingCompleted);
    } catch (err) { setError(err as ApiError); } finally { setBusy(false); }
  }

  async function sendCode(e?: FormEvent) {
    e?.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.otpRequest(email);
      setStep("code"); setCode(""); setCooldown(r.resendAfterSeconds);
      setSentInfo(`If ${email} can receive mail, a 6-digit code is on its way. It expires in ${Math.round(r.expiresInSeconds / 60)} minutes.`);
    } catch (err) {
      const ae = err as ApiError;
      if (ae.code === "OTP_COOLDOWN") { setCooldown(Number(ae.meta.retryAfterSeconds ?? 60)); if (step === "email") setStep("code"); }
      setError(ae);
    } finally { setBusy(false); }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await otpVerify(email, code); done(r.isNewUser || !r.user.onboardingCompleted); }
    catch (err) { setError(err as ApiError); setCode(""); codeRef.current?.focus(); } finally { setBusy(false); }
  }

  const otpMessage = (() => {
    if (!error) return null;
    switch (error.code) {
      case "OTP_INVALID": return typeof error.meta.attemptsRemaining === "number" ? `${error.message} ${error.meta.attemptsRemaining} attempt(s) left.` : error.message;
      case "OTP_COOLDOWN": return `Please wait ${cooldown || Number(error.meta.retryAfterSeconds ?? 0)}s before requesting another code.`;
      case "OTP_RATE_LIMITED": return "You've requested too many codes. Please try again in about an hour, or sign in another way.";
      case "OTP_UNAVAILABLE": return "Email codes aren't available right now. Please use another sign-in method.";
      default: return error.message;
    }
  })();

  const googleBtn = (
    providers?.google === false ? (
      <Button variant="outline" size="lg" full disabled title="Google sign-in is not configured on this server"><GoogleIcon /> Continue with Google</Button>
    ) : (
      <a href={apiUrl("/auth/google")} className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-lg border border-border bg-surface px-6 text-base font-medium shadow-card transition-colors hover:bg-surface-muted"><GoogleIcon /> Continue with Google</a>
    )
  );

  const title = mode === "login" ? "Welcome back" : mode === "register" ? "Create your account" : step === "email" ? "Continue with email code" : "Check your email";
  const subtitle = mode === "login" ? "Sign in to manage your recruiter outreach." : mode === "register" ? "Takes under a minute. No card needed." : step === "email" ? "We'll email you a one-time code. No password needed." : `Enter the 6-digit code we sent to ${email}.`;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-700 to-slate-900 p-12 text-white lg:flex">
        <Brand className="[&>span:first-child]:bg-white/15 [&>span:first-child]:text-white" />
        <div>
          <h2 className="max-w-md text-4xl font-semibold leading-tight tracking-tight">Reach the right recruiters, one considered email at a time.</h2>
          <ul className="mt-8 space-y-3 text-indigo-100">
            {["Import contacts or add them by hand", "Personalise every message with your profile", "Review before sending. Nothing goes out automatically", "Track every send in your own history"].map((t) => (
              <li key={t} className="flex items-start gap-3"><CheckIcon className="mt-0.5 size-5 shrink-0 text-indigo-300" />{t}</li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-indigo-200">Your data stays private to your account.</p>
      </aside>

      <main className="flex flex-col">
        <div className="flex items-center justify-between p-4 sm:p-6">
          <Brand className="lg:invisible" />
          <ThemeSwitcher compact />
        </div>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-10 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>

          {notice && <Alert kind="warn" className="mt-5"><p>{notice}</p><button type="button" className="mt-1 text-xs underline" onClick={clearNotice}>Dismiss</button></Alert>}
          {urlError && <Alert className="mt-5"><p>{urlError}</p></Alert>}

          {mode !== "otp" && (
            <>
              <div className="mt-6">{googleBtn}</div>
              {providers?.google === false && <p className="mt-1.5 text-xs text-muted">Google sign-in isn't configured on this server yet.</p>}
              <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wide text-muted"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>

              <form onSubmit={submitPassword} noValidate className="space-y-4" aria-label={mode === "login" ? "Sign in with email and password" : "Create account"}>
                {error && !error.code.startsWith("OTP") && error.code !== "VALIDATION_ERROR" && <Alert><p>{error.message}</p></Alert>}
                {mode === "register" && (
                  <Field label="Full name" error={fieldErr("name")}>
                    {(a) => <Input {...a} required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} />}
                  </Field>
                )}
                <Field label="Email address" error={fieldErr("email")}>
                  {(a) => <Input {...a} required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" />}
                </Field>
                <Field label="Password" error={fieldErr("password")} hint={mode === "register" ? "At least 10 characters, with a letter and a number." : undefined}>
                  {(a) => <Input {...a} required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />}
                </Field>
                <Button type="submit" variant="primary" size="lg" full loading={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</Button>
              </form>

              <div className="mt-4">
                <Link to="/login/otp" className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-muted"><MailIcon className="size-4" /> Continue with Email OTP</Link>
              </div>
              <p className="mt-6 text-center text-sm text-muted">
                {mode === "login" ? <>New to JobHunting? <Link className="font-medium text-primary hover:underline" to="/register">Create an account</Link><br /><span className="text-xs">Forgot your password? Use an email code, then set a new one in Profile.</span></> : <>Already have an account? <Link className="font-medium text-primary hover:underline" to="/login">Sign in</Link></>}
              </p>
            </>
          )}

          {mode === "otp" && (
            <div className="mt-6">
              {step === "email" ? (
                <form onSubmit={sendCode} noValidate className="space-y-4" aria-label="Request email code">
                  {error && <Alert><p>{otpMessage ?? error.message}</p></Alert>}
                  <Field label="Email address" error={fieldErr("email")} hint="New here? Entering a code creates your account.">
                    {(a) => <Input {...a} required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" autoFocus />}
                  </Field>
                  <Button type="submit" variant="primary" size="lg" full loading={busy}>{busy ? "Sending code…" : "Send code"}</Button>
                </form>
              ) : (
                <form onSubmit={verifyCode} noValidate className="space-y-4" aria-label="Verify email code">
                  {sentInfo && !error && <Alert kind="ok"><p>{sentInfo}</p></Alert>}
                  {error && <Alert><p>{otpMessage ?? error.message}</p></Alert>}
                  <Field label="6-digit code" error={fieldErr("code")}>
                    {(a) => <Input {...a} ref={codeRef} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} className="text-center text-2xl tracking-[0.5em] font-semibold" placeholder="••••••" />}
                  </Field>
                  <Button type="submit" variant="primary" size="lg" full loading={busy} disabled={code.length !== 6}>{busy ? "Verifying…" : "Verify and continue"}</Button>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <button type="button" className="min-h-9 text-muted underline" onClick={() => { setStep("email"); setError(null); }}>Use a different email</button>
                    <button type="button" className="min-h-9 font-medium text-primary disabled:cursor-not-allowed disabled:text-muted disabled:no-underline hover:underline" disabled={cooldown > 0 || busy} onClick={() => sendCode()}>
                      {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
                    </button>
                  </div>
                </form>
              )}
              <p className="mt-6 text-center text-sm text-muted"><Link className="font-medium text-primary hover:underline" to="/login">← Back to sign in</Link></p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
