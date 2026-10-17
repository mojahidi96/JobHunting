import type * as T from "./types";

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: string[] = [], public meta: Record<string, unknown> = {}) { super(message); }
}

let csrfToken = "";
export const setCsrf = (t: string) => { csrfToken = t; };
let onUnauthenticated: (code: string) => void = () => {};
/** Called for any 401 from a non-/auth/ endpoint (expired or revoked session). */
export const setUnauthenticatedHandler = (fn: (code: string) => void) => { onUnauthenticated = fn; };

type Query = Record<string, string | number | boolean | undefined | null>;
const qs = (q?: Query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

async function raw(method: string, path: string, opts: { body?: unknown; form?: FormData; query?: Query; background?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  // Polling must not keep a session alive: the server ignores requests flagged as background for inactivity tracking.
  if (opts.background) headers["X-Background"] = "1";
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.body); }
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs(opts.query)}`, { method, headers, body, credentials: "include" });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    let e: { error?: { code?: string; message?: string; details?: unknown[]; meta?: Record<string, unknown> } } = {};
    try { e = await res.json(); } catch { /* non-JSON error */ }
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthenticated(e.error?.code ?? "UNAUTHENTICATED");
    throw new ApiError(res.status, e.error?.code ?? "ERROR", e.error?.message ?? `Request failed (${res.status}).`, (e.error?.details ?? []).map(String), e.error?.meta ?? {});
  }
  return res;
}
const json = async <R,>(method: string, path: string, opts?: Parameters<typeof raw>[2]) => (await (await raw(method, path, opts)).json()) as R;

export const api = {
  /* auth */
  providers: () => json<T.Providers>("GET", "/auth/providers"),
  register: (b: { name: string; email: string; password: string }) => json<T.SignInResponse>("POST", "/auth/register", { body: b }),
  login: (b: { email: string; password: string }) => json<T.SignInResponse>("POST", "/auth/login", { body: b }),
  otpRequest: (email: string) => json<{ ok: true; expiresInSeconds: number; resendAfterSeconds: number }>("POST", "/auth/otp/request", { body: { email } }),
  otpVerify: (email: string, code: string) => json<T.SignInResponse>("POST", "/auth/otp/verify", { body: { email, code } }),
  logout: () => json<{ ok: true }>("POST", "/auth/logout", { body: {} }),
  me: () => json<{ user: T.User; csrfToken: string; hasPassword: boolean; session: { expiresAt: string; idleExpiresAt: string } }>("GET", "/auth/me"),
  changePassword: (b: { currentPassword?: string; newPassword: string }) => json<{ ok: true; csrfToken: string }>("POST", "/auth/password", { body: b }),
  completeOnboarding: (b: { name: string; headline?: string; experienceYears?: number | null; skillsSummary?: string }) => json<{ user: T.User; profile: T.Profile }>("POST", "/onboarding/complete", { body: b }),
  /* profile */
  profile: () => json<{ profile: T.Profile }>("GET", "/profile"),
  saveProfile: (b: Partial<Omit<T.Profile, "loginEmail" | "profilePhotoUrl" | "createdAt" | "updatedAt">>) => json<{ profile: T.Profile }>("PATCH", "/profile", { body: b }),
  uploadPhoto: (file: File) => { const f = new FormData(); f.append("photo", file); return json<{ profile: T.Profile }>("POST", "/profile/photo", { form: f }); },
  removePhoto: () => json<{ profile: T.Profile }>("DELETE", "/profile/photo"),
  exportAccount: async () => (await raw("GET", "/account/export")).blob(),
  deleteAccount: (b: { password?: string; confirmEmail?: string }) => json<{ ok: true }>("DELETE", "/account", { body: { ...b, confirm: true } }),
  /* sender */
  senderSettings: () => json<{ settings: T.SenderSettings }>("GET", "/settings/email"),
  saveSender: (b: { senderName: string; senderEmail: string; appPassword?: string }) => json<{ settings: T.SenderSettings }>("PUT", "/settings/email", { body: b }),
  testSender: () => json<{ settings: T.SenderSettings }>("POST", "/settings/email/test", { body: {} }),
  removeSender: () => json<{ settings: T.SenderSettings }>("DELETE", "/settings/email"),
  /* contacts */
  contacts: (q: Query) => json<T.Page<T.Contact>>("GET", "/recruiters", { query: q }),
  createContact: (b: T.ContactInput) => json<{ item: T.Contact }>("POST", "/recruiters", { body: b }),
  updateContact: (id: string, b: Partial<T.ContactInput>) => json<{ item: T.Contact }>("PATCH", `/recruiters/${id}`, { body: b }),
  deleteContact: (id: string) => json<{ ok: true }>("DELETE", `/recruiters/${id}`),
  bulkDelete: (ids: string[]) => json<{ deleted: number }>("POST", "/recruiters/bulk-delete", { body: { ids } }),
  exportContacts: async (q: Query) => (await raw("GET", "/recruiters/export", { query: q })).blob(),
  /* imports */
  imports: () => json<{ items: T.ImportRecord[] }>("GET", "/imports"),
  sampleJson: async () => (await raw("GET", "/imports/sample")).blob(),
  previewImport: (file: File, mapping: Record<string, string>, worksheet?: string) => {
    const f = new FormData(); f.append("file", file); f.append("mapping", JSON.stringify(mapping)); if (worksheet) f.append("worksheet", worksheet);
    return json<T.ImportPreview>("POST", "/imports/preview", { form: f });
  },
  runImport: (file: File, mapping: Record<string, string>, worksheet?: string) => {
    const f = new FormData(); f.append("file", file); f.append("mapping", JSON.stringify(mapping)); if (worksheet) f.append("worksheet", worksheet);
    return json<{ import: T.ImportRecord }>("POST", "/imports", { form: f });
  },
  deleteImport: (id: string, deleteContacts: boolean) => json<{ ok: true }>("DELETE", `/imports/${id}`, { query: { deleteContacts } }),
  /* templates */
  templates: () => json<{ items: T.Template[]; onboardingCompleted: boolean }>("GET", "/email-templates"),
  starters: () => json<{ items: { key: string; name: string; subject: string; html: string; placeholderConfig: T.PlaceholderConfig }[] }>("GET", "/email-templates/starters"),
  placeholders: () => json<{ builtins: T.PlaceholderConfig; contactFields: string[]; profileFields: string[] }>("GET", "/email-templates/placeholders"),
  createTemplate: (b: { name: string; subject: string; html: string; placeholderConfig: T.PlaceholderConfig; starterKey?: string }) => json<{ item: T.Template }>("POST", "/email-templates", { body: b }),
  updateTemplate: (id: string, b: Partial<{ name: string; subject: string; html: string; placeholderConfig: T.PlaceholderConfig; isDefault: true }>) => json<{ item: T.Template }>("PATCH", `/email-templates/${id}`, { body: b }),
  duplicateTemplate: (id: string) => json<{ item: T.Template }>("POST", `/email-templates/${id}/duplicate`, { body: {} }),
  resetTemplate: (id: string) => json<{ item: T.Template }>("POST", `/email-templates/${id}/reset`, { body: {} }),
  reviewTemplate: (id: string, version: number) => json<{ item: T.Template }>("POST", `/email-templates/${id}/review`, { body: { confirmation: true, version } }),
  deleteTemplate: (id: string) => json<{ ok: true }>("DELETE", `/email-templates/${id}`),
  /* sending */
  preview: (b: { templateId?: string; template?: { subject: string; html: string; placeholderConfig: T.PlaceholderConfig }; contactIds: string[]; perSendValues?: Record<string, string>; options?: { skipRowsMarkedNo?: boolean } }) =>
    json<T.PreviewResponse>("POST", "/emails/preview", { body: b }),
  send: (b: { templateId: string; contactIds: string[]; perSendValues?: Record<string, string>; options?: { skipRowsMarkedNo?: boolean }; idempotencyKey: string }) =>
    json<{ job: T.Job; replayed: boolean }>("POST", "/emails/send", { body: { ...b, confirmation: true } }),
  job: (id: string, background = false) => json<{ job: T.Job; recipients: T.HistoryItem[] }>("GET", `/emails/jobs/${id}`, { background }),
  jobs: () => json<{ items: T.Job[] }>("GET", "/emails/jobs"),
  retry: (jobId: string, idempotencyKey: string) => json<{ job: T.Job; replayed: boolean }>("POST", `/emails/jobs/${jobId}/retry`, { body: { confirmation: true, idempotencyKey } }),
  history: (q: Query) => json<T.Page<T.HistoryItem> & { counts: { attempted: number; sent: number; failed: number; skipped: number } }>("GET", "/emails/history", { query: q }),
};

export const newIdempotencyKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-xxxxxxxx`);

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const apiUrl = (path: string) => `${BASE}${path}`;
