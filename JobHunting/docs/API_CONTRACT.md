# API Contract — JobHunting

Single source of truth for `backend/` and `frontend/` (`frontend/src/types.ts` and `frontend/src/api.ts` mirror it;
`backend/src/lib/dto.ts` produces the DTOs). **Change this file first, then both sides.**

- Base URL: `/api` (dev: Vite proxies `/api` → `http://localhost:4000`).
- JSON bodies ≤ 300 kB. File uploads are `multipart/form-data`.
- Unknown keys in request bodies are rejected with `VALIDATION_ERROR` on `strict` endpoints (marked ⛔). This is how
  client-supplied `from`, `to`, `recipients` or `userId` are refused.
- IDs are 24-char hex strings. Dates are ISO-8601 UTC.

## Authentication, sessions, CSRF, ownership
Sign-in methods: **email + password**, **email OTP**, **Google**. All of them end in the same server-side session.

- **Cookie:** random token in `jh_session` (**HttpOnly, SameSite=Lax, Secure in production**, `Path=/`). Only a SHA-256 hash is stored (`sessions`). Credentials are never placed in localStorage or returned in JSON.
- **Server-controlled expiry** (config `SESSION_IDLE_DAYS`=7, `SESSION_MAX_DAYS`=7):
  - *Inactivity:* a session whose `lastActiveAt` is older than the idle window is deleted and rejected with `401 SESSION_EXPIRED`.
  - *Absolute lifetime:* `expiresAt = createdAt + max`, never extended. With both at 7 days the maximum is the binding rule; raise `SESSION_MAX_DAYS` to get a true sliding 7-day window.
  - *What counts as activity:* any authenticated request (including `GET /auth/me` on page load) updates `lastActiveAt` (at most once a minute). A request with header `X-Background: 1` (the UI sets it on polling) is authenticated but **does not** extend the session.
- **Missing / unknown session:** `401 UNAUTHENTICATED`. Expired: `401 SESSION_EXPIRED`. The UI clears its in-memory state and redirects to `/login` with a notice.
- **Revocation:** logout deletes the session immediately. Changing/setting the password deletes **all** of the user's sessions and issues a new one (rotation; the response carries the new `csrfToken`).
- **CSRF:** every non-GET request to an authenticated route must send `X-CSRF-Token: <csrfToken>` (returned by register/login/otp-verify/me/password, bound to the session) and, if an `Origin` header is present, it must be in `CORS_ORIGIN`. Else `403 CSRF_INVALID` / `FORBIDDEN_ORIGIN`. Unauthenticated sign-in endpoints are exempt (they have no session yet).
- **Ownership:** every query is scoped by the session's `userId`. A resource owned by someone else is indistinguishable from a missing one (`404`). Clients never send a `userId`.
- **Rate limits** (`429 RATE_LIMITED`, per IP): password register/login/change 20/15 min, OTP request 10/15 min, OTP verify 30/15 min, sender test 10/10 min, send/retry 10/min, import 30/min, export 20/min. OTP has additional per-email limits (below).

## Errors
```ts
type ApiErrorBody = { error: { code: string; message: string; details: unknown[]; meta?: Record<string, unknown> } };
// meta examples: { retryAfterSeconds } (OTP_COOLDOWN, OTP_RATE_LIMITED), { attemptsRemaining } (OTP_INVALID)
```
No stack traces, paths, credentials or provider responses. Common codes: `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401,
`CSRF_INVALID`/`FORBIDDEN_ORIGIN` 403, `NOT_FOUND` 404, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_FILE_TYPE` 415, `RATE_LIMITED` 429, `INTERNAL_ERROR` 500.

## Types
```ts
type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";
type JobStatus = "queued" | "running" | "completed" | "completed_with_errors" | "failed";
type FieldSource = "contact" | "profile" | "manual" | "perSend" | "static";

type Theme = "light" | "dark" | "system";
type User = { id; name; email; profilePhotoUrl: string | null; templateOnboardingCompletedAt: string | null;
              onboardingCompleted: boolean; emailVerified: boolean; googleLinked: boolean; theme: Theme; createdAt };
type Profile = { name; loginEmail; profilePhotoUrl; theme: Theme; phone; headline; experienceYears: number | null; skillsSummary;
                 resumeUrl; linkedinUrl; location; targetRoles; noticePeriod; createdAt; updatedAt };
type SenderSettings = { provider: "gmail_smtp"; loginEmail; senderName; senderEmail;
                        status: "not_configured" | "unverified" | "verified" | "failed";
                        verifiedAt: string | null; lastError: string | null; hasCredential: boolean };
type Contact = { id; Name; Company; Email; Role; Link: string | null; isSend: "yes" | "no" | null;
                 source: { type: "manual" | "import"; importId: string | null };
                 deliveryStatus: DeliveryStatus; lastDelivery: { status; at; error } | null; createdAt; updatedAt };
type FieldConfig = { source: FieldSource; field?: string; value?: string; allowEmpty?: boolean };
type Template = { id; name; subject; html; placeholderConfig: Record<string, FieldConfig>; version: number; isDefault: boolean;
                  starterKey: string | null; reviewedVersion: number | null; reviewed: boolean; reviewedAt; createdAt; updatedAt };
type Job = { jobId; status: JobStatus; totals: { selected; sent; failed; skipped };
             sender: { provider; senderName; senderEmail }; template: { templateId; name; version } | null;
             options: { delayMinMs; delayMaxMs; skipRowsMarkedNo }; retryOf: string | null; createdAt; startedAt; finishedAt };
type HistoryItem = { id; jobId; contactId; recipient: { Name; Company; Email; Role }; status: DeliveryStatus; subject: string | null;
                     templateVersion: number | null; error: { code; message; retryable: boolean } | null;
                     providerMessageId: string | null; retryOf: string | null; retried: boolean; createdAt; completedAt };
```
`isSend` is source data. **It is not delivery status** (`deliveryStatus` / history are what the app actually did).
"sent" means *accepted by the sending provider*, never "delivered to the inbox".

## Auth
Every success response that signs a user in has the shape `{ user: User, csrfToken: string, isNewUser: boolean }` and sets the session cookie.

| Endpoint | Request → Response |
|---|---|
| `GET /auth/providers` (public) | → `200 { password: true, google: boolean, otp: boolean }` — which methods this deployment has configured. The UI disables unavailable buttons. |
| `POST /auth/register` ⛔ | `{ name(1–100), email, password }` → `201` sign-in shape. Password: 10–128 chars with at least one letter and one number. Only these three fields are accepted. The account starts `emailVerified:false`. Duplicate → `409 ACCOUNT_EXISTS` (generic message). Creates one default `generic` template. |
| `POST /auth/login` ⛔ | `{ email, password }` → `200` sign-in shape. `401 INVALID_CREDENTIALS` is identical for unknown email, wrong password and accounts without a password. |
| `POST /auth/otp/request` ⛔ | `{ email }` → `200 { ok:true, expiresInSeconds:600, resendAfterSeconds:60 }`. Identical for known and unknown addresses; **never contains the code**. Errors: `429 OTP_COOLDOWN` (`meta.retryAfterSeconds`), `429 OTP_RATE_LIMITED`, `503 OTP_UNAVAILABLE` (no auth SMTP configured), `502 OTP_SEND_FAILED` (the new code is discarded). |
| `POST /auth/otp/verify` ⛔ | `{ email, code: "123456" }` → `200` sign-in shape (`isNewUser:true` when the account was just created). Errors: `400 OTP_INVALID` (`meta.attemptsRemaining`), `400 OTP_EXPIRED`, `429 OTP_LOCKED`. |
| `GET /auth/google` | Browser navigation. Starts OAuth 2.0 authorization-code flow with PKCE (S256), `state` and `nonce`; sets short-lived HttpOnly cookie `jh_oauth` (`Path=/api/auth/google`) and `302`s to Google. If not configured → `302 {FRONTEND_URL}/login?error=google_unavailable`. |
| `GET /auth/google/callback?code&state` | Browser redirect from Google. On success sets the session cookie and `302 {FRONTEND_URL}/`. On any problem `302 {FRONTEND_URL}/login?error=<code>` with `google_denied` (user cancelled), `google_unverified` (Google email not verified), `google_conflict` (email already linked to another Google account), `google_failed` (bad/replayed state, nonce, token, exchange), `google_unavailable`. The state record is consumed on first use, so a replayed callback cannot sign in or create anything. |
| `POST /auth/logout` | `{}` → `200 { ok }`; the session is deleted immediately. |
| `GET /auth/me` | → `200 { user, csrfToken, hasPassword: boolean, session: { expiresAt, idleExpiresAt } }` · `401 UNAUTHENTICATED \| SESSION_EXPIRED`. Used to restore the session on reload. |
| `POST /auth/password` ⛔ | `{ currentPassword?, newPassword }` → `200 { ok, csrfToken }`. `currentPassword` is required if the account already has a password (`403 INVALID_CREDENTIALS`). Revokes all sessions and rotates the current one. This is also the "forgot password" path: sign in with Email OTP, then set a new password. |

**OTP rules:** 6 digits from a CSPRNG; valid 10 minutes; single use; only an HMAC (keyed with server secret) is stored; requesting a new code invalidates the previous active one; 60 s resend cooldown and at most 5 codes per email per hour; 5 wrong guesses lock the code (guess counting is atomic); codes are never returned, logged or placed in browser storage. Delivery uses the dedicated `AUTH_SMTP_*` transactional account, not any user's outreach credentials.

**Account linking:** one user per email. A Google subject, an OTP, or a password all resolve to the same user id (so contacts/templates/history are retained). An existing account is linked only because the email was *just verified* (Google `email_verified`, or OTP). If that account's email had never been verified (e.g. password sign-up), its password is removed on linking, so a squatter who pre-registered an address cannot keep access. Concurrent first sign-ins converge on one user through unique indexes (`email`, `googleSub`).

**Onboarding:** `User.onboardingCompleted` is false until `POST /onboarding/complete`. The UI shows a short form after the first sign-in, whatever the method.

## Profile & account
| Endpoint | Notes |
|---|---|
| `GET /profile` → `{ profile }` | |
| `POST /onboarding/complete` ⛔ `{ name, headline?, experienceYears?: number\|null, skillsSummary? }` → `{ user, profile }` | Only `name` is required; all else is optional and editable later. Marks onboarding complete. |
| `PATCH /profile` ⛔ → `{ profile }` | Any of `theme (light\|dark\|system), name, phone, headline, experienceYears, skillsSummary, resumeUrl, linkedinUrl, location, targetRoles, noticePeriod`. URLs must be http(s) or `""`. `loginEmail` is not editable. |
| `POST /profile/photo` (multipart field `photo`) → `{ profile }` | PNG/JPEG/WebP detected from file **content**, ≤ 2 MB. `415 UNSUPPORTED_FILE_TYPE`, `413`. Stored privately under `UPLOAD_DIR/avatars/<generated>`; no client path is accepted. |
| `GET /profile/photo` | Owner-only image bytes (`nosniff`). `404` if none. |
| `DELETE /profile/photo` → `{ profile }` | |
| `GET /account/export` | JSON download of everything the user owns (no hashes/credentials). |
| `DELETE /account` ⛔ `{ confirm: true, password? , confirmEmail? }` | Accounts with a password must send `password`; Google/OTP-only accounts must send `confirmEmail` equal to their email (`403 INVALID_CREDENTIALS`). Deletes user, contacts, imports, templates, jobs, history, sessions, photo. `409 JOB_ACTIVE` while a job runs. |

## Sender (Email Sending Settings)
The sending identity is **separate from the login email**. v1 supports Gmail SMTP with an **App Password** (OAuth is not implemented).
The password is AES-256-GCM encrypted with `ENCRYPTION_KEY`, never returned, never logged.

| Endpoint | Notes |
|---|---|
| `GET /settings/email` → `{ settings: SenderSettings }` | |
| `PUT /settings/email` ⛔ `{ senderName, senderEmail, appPassword? }` → `{ settings }` | `appPassword` must be 16 alphanumerics (spaces ignored). Required the first time. Changing the email or password resets `status` to `unverified`. `409 JOB_ACTIVE` during a running job. |
| `POST /settings/email/test` → `{ settings }` | Authenticates to the provider only; **sends nothing**. Sets `verified` or `failed` (safe message in `lastError`). `409 SENDER_NOT_CONFIGURED`. |
| `DELETE /settings/email` → `{ settings }` | Removes sender and credential. |

## Contacts
`isSend` accepts `yes|no|null`. Required: `Name, Company, Email, Role`. `Link` must be http(s) or null. `Email` is unique per user, case-insensitively.

| Endpoint | Notes |
|---|---|
| `GET /recruiters?q&isSend=yes\|no\|unset&status&importId&sort&order&page&pageSize` → `{ items, total, page, pageSize }` | `sort` ∈ `Name, Company, Email, Role, createdAt, deliveryStatus`; `q` searches name/company/email/role (literal, escaped); `pageSize` ≤ 200. |
| `POST /recruiters` ⛔ `{ Name, Company, Email, Role, Link?, isSend? }` → `201 { item }` | `409 DUPLICATE_CONTACT` |
| `PATCH /recruiters/:id` ⛔ (partial) → `{ item }` | `404`, `409` |
| `DELETE /recruiters/:id` → `{ ok }` | |
| `POST /recruiters/bulk-delete` `{ ids[1..1000] }` → `{ deleted }` | |
| `GET /recruiters/export?format=xlsx\|json&scope=all\|filtered\|selected&ids=a,b&includeStatus=true&<list filters>` | File download. Columns `Name, Company, Email, Role, Link, isSend` (+ `deliveryStatus` only if `includeStatus=true`). Never includes credentials, other users' rows or paths. Cells starting with `= + - @` are prefixed with `'` (formula injection). Sheet name `Recruiters_Email`. |

## Imports (never send email)
Supported: `.xlsx` (first worksheet unless `worksheet` is given), `.xls`, `.json` (array of objects). ≤ 5 MB, ≤ 5000 rows. File type is verified from content.
Auto-mapping is case/space-insensitive; override with `mapping` = JSON `{ "Name": "Full Name", ... }` (standard field → source header).
**Files are not retained**; only metadata is stored. `storageRef` (`imports/<id>`) is a logical reference, never a filesystem path.

| Endpoint | Notes |
|---|---|
| `GET /imports/sample` | Sample JSON download. |
| `POST /imports/preview` (multipart `file`, optional `mapping`, `worksheet`) → `{ file:{name,format,worksheetName}, headers, mapping, unknownColumns, missingRequired, counts:{total,accepted,rejected,duplicates,skipped}, rows[≤200]:{row,status,errors,contact}, truncated }` | Saves nothing. Row = Excel row number (header is row 1) or JSON index + 1. Duplicates are checked within the file and against the user's existing contacts. |
| `POST /imports` (same form) → `201 { import }` | Saves accepted rows with `source.type="import"`. `422 MISSING_COLUMNS` (details = unmapped required fields), `422 NOTHING_TO_IMPORT`. |
| `GET /imports` → `{ items: Import[] }` | `Import = { id, originalFilename, format, worksheetName, counts, errors[≤200], storageRef, importedAt }` |
| `DELETE /imports/:id?deleteContacts=true\|false` → `{ ok, deletedContacts }` | |

## Templates
Placeholders (names are case-sensitive, `{{Name}}` style, whitespace inside braces allowed).

| Source | Built-in placeholders |
|---|---|
| contact | `Name firstName Company Role Email Link` (`firstName` = first token of `Name`) |
| profile | `SENDER_NAME` (sender identity name, falls back to account name) `SENDER_EMAIL` (sending address) `CONTACT_NO` `RESUME_LINK` `LINKEDIN_LINK` `HEADLINE` `SKILLS_SUMMARY` |

Any other token (e.g. `{{AVAILABILITY}}`) must be defined in the template's `placeholderConfig`:
`manual`/`static` → `{ value }`, `perSend` → supplied at send time in `perSendValues`, `contact`/`profile` → `{ field }` (allowed names above).
A config entry also overrides a built-in's default source. `allowEmpty: true` is the explicit empty fallback.

**Resolution & precedence:** per token, the template's `placeholderConfig[token]` wins; otherwise the built-in default; otherwise the token is *unknown*.
`perSendValues` apply only to tokens whose source is `perSend`. Resolved values are trimmed. A value that is empty and not `allowEmpty`, or an unknown token, is **unresolved**.
Unresolved tokens stay visible in previews and **block sending** (`422 PLACEHOLDERS_UNRESOLVED`, details list them).
Values are HTML-escaped in the body, plain text (CR/LF removed) in the subject, substituted in a single pass (values are never re-scanned).
The final HTML is sanitized (no scripts/forms/iframes/event handlers/`javascript:` URLs; `img` https only). Preview and send use the same renderer.

| Endpoint | Notes |
|---|---|
| `GET /email-templates` → `{ items, onboardingCompleted }` | |
| `GET /email-templates/starters` → `{ items:[{key,name,subject,html,placeholderConfig}] }` | New users get only `generic` seeded as their default template. `frontend-lead-example` (the original `sendEmails.js` message) remains available here as an optional starter but is not seeded and has no UI button. |
| `GET /email-templates/placeholders` → `{ builtins, contactFields, profileFields }` | |
| `POST /email-templates` ⛔ `{ name, subject(≤300), html(≤100k), placeholderConfig?, starterKey? }` → `201 { item }` | First template becomes default. `409 DUPLICATE_TEMPLATE_NAME`. |
| `GET /email-templates/:id` → `{ item }` | |
| `PATCH /email-templates/:id` ⛔ partial of `name, subject, html, placeholderConfig, isDefault:true` → `{ item }` | Changing subject/html/placeholderConfig does `version += 1`, which invalidates the review. Rename / default do not. |
| `POST /email-templates/:id/duplicate` → `201 { item }` | name "… (copy)" |
| `POST /email-templates/:id/reset` → `{ item }` | Restores starter content, bumps version. `409 NO_STARTER`. |
| `POST /email-templates/:id/review` `{ confirmation: true, version }` → `{ item }` | Records that **this version** was reviewed; sets `templateOnboardingCompletedAt`. `409 VERSION_MISMATCH`. |
| `DELETE /email-templates/:id` → `{ ok }` | If it was the default another template becomes default. |

## Sending
Preview and send resolve contacts **server-side** from the user's own contacts; unknown/foreign ids → `404 CONTACT_NOT_FOUND`.
`from` always comes from the user's stored, verified sender; there are no `from`/`to` fields (⛔ rejects them).

### POST /emails/preview ⛔ — never sends
Request: `{ templateId | template:{subject,html,placeholderConfig} (exactly one), contactIds[1..500], perSendValues?, options?:{skipRowsMarkedNo?} }`
Response:
```ts
{ sender: { provider, loginEmail, senderName, senderEmail, status },
  template: { id, name, version, reviewed },            // null fields for inline templates
  summary: { selected, eligible, skipped },
  options: { delayMinMs, delayMaxMs, skipRowsMarkedNo },
  perSendFields: string[],
  items: { contactId, to, name, company, status: "eligible"|"skipped", skipReason, subject,
           html: string|null /* only first 10 items */, warnings: string[], previouslySentAt: string|null }[],
  problems: { code, message, details: string[] }[],     // what would block a real send
  canSend: boolean }
```
Problem codes: `SENDER_NOT_VERIFIED`, `TEMPLATE_NOT_REVIEWED` (saved templates only), `PLACEHOLDERS_UNRESOLVED`, `NO_ELIGIBLE_RECIPIENTS`.
Skipped: `isSend = no` (when `skipRowsMarkedNo`, default true) and duplicate addresses within the request.

### POST /emails/send ⛔
Request: `{ templateId, contactIds[1..500], perSendValues?, options?, confirmation: true, idempotencyKey(8–100) }`
- `options.delayMinMs/delayMaxMs` are clamped to `MIN/MAX_DELAY_BOUND_MS` (default 30 000–300 000); default 45 000–90 000. Delay occurs only **between** sends.
- `202 { job, replayed:false }`. Same `idempotencyKey` again → `200 { job, replayed:true }` and nothing is sent.
- Errors: `400 CONFIRMATION_REQUIRED`, `409 SENDER_NOT_VERIFIED`, `409 TEMPLATE_NOT_REVIEWED`, `422 PLACEHOLDERS_UNRESOLVED`, `422 NO_ELIGIBLE_RECIPIENTS`, `409 JOB_ACTIVE` (one queued/running job per user, enforced by a partial unique index), `404`.

### Jobs and history
| Endpoint | Notes |
|---|---|
| `GET /emails/jobs` → `{ items: Job[] }` | last 50 |
| `GET /emails/jobs/:jobId` → `{ job, recipients: HistoryItem[] }` | Real, persisted state. Poll while `queued`/`running`. |
| `POST /emails/jobs/:jobId/retry` ⛔ `{ confirmation:true, idempotencyKey, historyIds? }` → `202 { job }` | New auditable job (`retryOf`). Only recipients with `status=failed`, `error.retryable=true`, not already retried. `OUTCOME_UNKNOWN` is never retryable. `422 NOTHING_TO_RETRY`, `409 JOB_ACTIVE`. Uses the original job's template snapshot and resolved values. |
| `GET /emails/history?q&status&jobId&from&to&sort=createdAt\|status\|Name\|Company\|Email&order&page&pageSize(≤100)` → `{ items, total, page, pageSize, counts:{attempted,sent,failed,skipped} }` | `attempted = sent + failed`. `counts` ignore the `status` filter. |
| `GET /emails/history/:id` → `{ item }` | |

Error codes in `HistoryItem.error.code`: `SKIPPED`, `AUTH_FAILED`, `RECIPIENT_REJECTED`, `TEMPORARY_FAILURE` (retryable), `CONNECTION_FAILED` (retryable),
`OUTCOME_UNKNOWN` (timeout/crash mid-send; **not** retryable), `SEND_FAILED`, `JOB_ABORTED` / `INTERRUPTED` / `SENDER_UNAVAILABLE` (never attempted; retryable).

## Health
`GET /api/health` → `{ status:"ok", service:"jobhunting-api", database:"up"|"down" }` (no auth).

## Retention
See README "Data, retention and privacy".
