import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { Alert } from "../components/common";
import { CheckIcon } from "../components/icons";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { Badge, Button, Card, Field, Input, Textarea } from "../components/ui";

/** Minimal first-run step: only the name is required. Everything else is optional and editable later in Profile. */
export function OnboardingPage() {
  const { user, setUser, logout } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState(user?.name ?? "");
  const [headline, setHeadline] = useState("");
  const [years, setYears] = useState("");
  const [skills, setSkills] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save(skip: boolean) {
    setBusy(true); setError(null);
    try {
      const body = skip ? { name: name.trim() } : {
        name: name.trim(), headline: headline.trim(), skillsSummary: skills.trim(),
        experienceYears: years === "" ? null : Number(years),
      };
      const r = await api.completeOnboarding(body);
      setUser(r.user);
      nav("/", { replace: true });
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void save(false); };

  return (
    <div className="min-h-dvh">
      <div className="flex items-center justify-between p-4 sm:p-6">
        <span className="flex items-center gap-2.5 font-semibold"><span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground"><CheckIcon className="size-5" /></span>JobHunting</span>
        <div className="flex items-center gap-3"><ThemeSwitcher compact /><Button variant="ghost" size="sm" onClick={() => logout()}>Sign out</Button></div>
      </div>
      <main className="mx-auto w-full max-w-xl px-4 pb-12 sm:px-6">
        <div className="mb-6">
          <p className="text-sm font-medium text-primary">Step 1 of 1</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Welcome! Let's set up your profile</h1>
          <p className="mt-1 text-sm text-muted">Just your name to start. Everything else is optional. You can add it later in Profile.</p>
        </div>
        <Card className="p-5 sm:p-6">
          <form onSubmit={submit} noValidate className="space-y-4">
            {error && <Alert><p>{error.message}</p>{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</Alert>}
            <Field label="Full name">{(a) => <Input {...a} required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} />}</Field>
            <Field label={<span className="flex items-center gap-2">Email {user?.emailVerified && <Badge tone="success">✓ Verified</Badge>}</span>} hint="This is the address you sign in with.">
              {(a) => <Input {...a} value={user?.email ?? ""} readOnly />}
            </Field>
            <Field label={<>Professional headline or target role <span className="font-normal text-muted">(optional)</span></>}>
              {(a) => <Input {...a} value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={160} placeholder="e.g. Frontend Lead" />}
            </Field>
            <Field label={<>Years of experience <span className="font-normal text-muted">(optional)</span></>}>
              {(a) => <Input {...a} type="number" min={0} max={70} inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} className="sm:max-w-40" />}
            </Field>
            <Field label={<>Skills summary <span className="font-normal text-muted">(optional)</span></>}>
              {(a) => <Textarea {...a} rows={4} value={skills} onChange={(e) => setSkills(e.target.value)} maxLength={2000} placeholder="e.g. TypeScript, React, Node.js, system design" />}
            </Field>
            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" disabled={busy || !name.trim()} onClick={() => save(true)}>Skip for now</Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Continue</Button>
            </div>
          </form>
        </Card>
      </main>
    </div>
  );
}
