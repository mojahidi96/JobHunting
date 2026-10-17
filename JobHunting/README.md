# JobHunting — Multi-user Recruiter Outreach

React + TypeScript UI styled with **Tailwind CSS v4**, Node/Express API, MongoDB Atlas (Mongoose). Every user has their own account, contacts,
templates, sender identity and email history. Nothing is ever sent on login, upload, import or page load.
The API is specified in [docs/API_CONTRACT.md](docs/API_CONTRACT.md) (the single source of truth for frontend and backend).

## Quick start (Node 20+)
```bash
cp backend/.env.example backend/.env     # fill MONGODB_URI and ENCRYPTION_KEY (see below)
npm run install:all
npm run db:init --prefix backend         # optional: creates collections + indexes in Atlas
npm run dev                              # UI http://localhost:5173, API http://localhost:4000/api
```
Open the UI → sign in (Google, email + password, or email code) → short onboarding → Email Sending Settings → add recruiters → send.

## MongoDB Atlas setup (manual — nothing here is created for you)
The code cannot create an Atlas project or database user; do this once in the Atlas console:
1. **Project** — create (or reuse) an Atlas project named `JobHunting`, then a cluster (a free M0 is fine).
2. **Database user** — Security → Database Access → add a user with *Read and write to any database* (or scope it to the `jobhunting` database). Use a strong generated password.
3. **Network access** — Security → Network Access → add your current IP (dev) and your server's egress IP (prod). Do **not** leave `0.0.0.0/0` in production. *Connection errors from a new machine are almost always this.*
4. **Connection string** — Cluster → Connect → Drivers → copy the `mongodb+srv://…` string and put the database name before the `?`:
   `mongodb+srv://<user>:<password>@<cluster-host>/jobhunting?retryWrites=true&w=majority&appName=JobHunting`
   URL-encode special characters in the password. Put it in `backend/.env` as `MONGODB_URI`. Never commit it.
5. **Database** — MongoDB creates `jobhunting` on first write; `npm run db:init --prefix backend` also creates the collections and indexes
   (`users, sessions, recruitercontacts, emailtemplates, emailjobs, emailhistory, imports`). Indexes are also synced on every non-production start; in production run `db:init` as part of deploy.
6. **Environments** — use a different database per environment (`jobhunting_dev`, `jobhunting_prod`) or a different cluster/user. Tests never touch Atlas: they run against an in-memory MongoDB.

If you reuse a connection string that points at another project's database (e.g. `…/content_review`), change the database name
segment to `jobhunting`, otherwise this app would write into that database.

## Backend environment (`backend/.env`; see `.env.example`)
| Variable | Notes |
|---|---|
| `MONGODB_URI` | Required. Atlas connection string (see above). |
| `ENCRYPTION_KEY` | Required. 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Encrypts saved sender app passwords (AES-256-GCM). If lost or changed, users must re-enter their app password. |
| `NODE_ENV` | `development` / `test` / `production`. Production forces `Secure` cookies and https-only `CORS_ORIGIN`. |
| `PORT`, `CORS_ORIGIN` | Default `4000`, `http://localhost:5173` (comma-separated origins). |
| `UPLOAD_DIR` | Private directory for profile photos (default `./uploads`, git-ignored, never served statically). |
| `SESSION_IDLE_DAYS`, `SESSION_MAX_DAYS` | Server-enforced session policy, both default `7` (see "Sign-in and sessions"). `SESSION_TTL_DAYS` is accepted as a fallback for the max. |
| `FRONTEND_URL` | Where the browser returns after Google sign-in. Defaults to the first `CORS_ORIGIN`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Optional. Enable Google sign-in (all three required). |
| `AUTH_SMTP_HOST`, `AUTH_SMTP_PORT`, `AUTH_SMTP_SECURE`, `AUTH_SMTP_USER`, `AUTH_SMTP_PASS`, `AUTH_SMTP_FROM` | Optional. Transactional SMTP for login OTP emails. Enables Email OTP. |
| `DEFAULT_DELAY_MIN_MS`, `DEFAULT_DELAY_MAX_MS`, `MIN_DELAY_BOUND_MS`, `MAX_DELAY_BOUND_MS` | Optional tuning. Defaults: delay 45–90 s; client delays clamped to 30–300 s. |

Frontend: `VITE_API_BASE_URL` (default `/api`). Production: serve the UI and API from the same site over HTTPS (or set `CORS_ORIGIN` to the UI origin), behind a TLS-terminating proxy (`trust proxy` is enabled in production).

## Sign-in and sessions
Three methods, one account per email (details and payloads in [docs/API_CONTRACT.md](docs/API_CONTRACT.md)):
- **Google** — OAuth 2.0 authorization-code flow with PKCE, `state` and `nonce`; the ID token is verified server-side and `email_verified` must be true.
- **Email + password** — Argon2id; registration asks only for name, email and password (10+ chars, a letter and a number).
- **Email OTP** — 6-digit code, 10-minute expiry, single use, hash-only storage, 60 s resend cooldown, 5 codes/hour/email, 5 guesses per code, IP rate limits. Codes are never returned or logged.

Google and OTP are **optional and off until configured** (`GET /api/auth/providers` tells the UI; the Google button is disabled otherwise). Neither is claimed to work until you configure and test it:

1. **Google:** Google Cloud Console → APIs & Services → OAuth consent screen (configure) → Credentials → *Create OAuth client ID* → *Web application*. Add the authorised redirect URI exactly as `GOOGLE_REDIRECT_URI` (dev: `http://localhost:5173/api/auth/google/callback`, which works through the Vite proxy; prod: `https://<your-domain>/api/auth/google/callback`). Put the client ID/secret in `backend/.env`.
2. **OTP email:** create a dedicated transactional sender (Postmark / SES / Resend / Mailgun SMTP, or a no-reply mailbox) and fill `AUTH_SMTP_*`. This is separate from users' recruiter-outreach credentials.

**Account linking.** A Google identity, an OTP and a password all resolve to the same user id, so contacts/templates/history are kept. An existing account is linked only because the email was *just verified* by Google or OTP, never from a bare matching address. If that account's email was never verified (password sign-up), its password is removed on linking, so someone who pre-registered an address cannot keep access. A password-less account can set a password in Profile → Security; "forgot password" is "sign in with an email code, then set a new one".

**Session policy (server-side, not frontend timers).** The session is an opaque random token in an HttpOnly, SameSite=Lax cookie (`Secure` in production); only its hash is stored. It ends after **7 days of inactivity** (`SESSION_IDLE_DAYS`) and after an **absolute 7-day maximum** (`SESSION_MAX_DAYS`). With both at 7 the maximum is the binding limit, so users sign in again at most every 7 days. If you want a true sliding window, raise `SESSION_MAX_DAYS`. Only real use extends the idle clock: UI polling sends `X-Background: 1` and is ignored for that purpose. Logout deletes the session immediately; changing the password revokes every session and rotates the current one. State-changing requests need the per-session `X-CSRF-Token` header. The UI keeps auth state in memory only, restores it with `GET /api/auth/me` on load, and on any 401 clears state and shows "your session expired" on the sign-in page. Nothing credential-like is put in localStorage; the only stored item is the theme preference (`jh_theme`).

## UI and themes
Tailwind CSS v4 with semantic design tokens (CSS variables in `frontend/src/styles/app.css`) and a small component kit in `frontend/src/components/ui.tsx` (Button, Field, Card, Badge, Stat, Skeleton, EmptyState, responsive table classes, toasts). Dark mode is class-based (`.dark` on `<html>`). The **Light / Dark / System** switcher is in the top bar, user menu and sign-in screens; it persists in localStorage, is applied by an inline script before first paint (no flash), follows the OS live in System mode, and is also saved to the account (`PATCH /api/profile {theme}`) and adopted on a new device. Layouts are mobile-first: drawer navigation and full-screen dialogs on phones, sidebar on desktop, tables become cards under `md`, `prefers-reduced-motion` is respected, and statuses always carry text/symbols.

## How sending identity works
Logging in does **not** authorise sending from your mailbox. In *Email Sending Settings* you enter the sender name, address and a
**Gmail App Password** (requires 2-Step Verification; never your normal password), then run **Test connection**, which signs in to Gmail and sends nothing.
Only a `verified` sender can send, and `From` is always taken from that stored identity — requests cannot supply a `From` or recipient address.
The password is stored AES-256-GCM-encrypted, is never returned by the API, and never appears in logs or history. Login email and sending identity are separate fields.
Gmail OAuth is **not implemented** (see gaps).

## Using the app
- **Recruiters** — add/edit/delete rows inline (no upload needed), search/filter/sort/paginate, import `.xlsx`/`.json` with column mapping and a validation preview, export selected/filtered/all as `.xlsx`/`.json` (optionally with delivery status). `isSend` (from your data) is shown separately from the app's *Delivery* status.
- **Email Templates / “Update Email Template”** — full HTML subject+body, placeholders, per-placeholder sources (contact, profile, saved value, ask at send time, static text), API-generated sandboxed preview, versions. Every user starts with one generic sample template, and **New template** opens the editor pre-filled with that sample: edit it, or clear it and write your own. **Before the first real send you must confirm you reviewed that template version**; any material edit requires review again.
- **Confirmations** — destructive or consequential actions (delete, remove sender, discard unsaved changes, retry, closing a running send) use in-app modal dialogs (`components/confirm.tsx`: `useConfirm()` / `usePrompt()`), not browser `confirm()` / `prompt()` popups.
- **Send** — select recruiters → *Send emails* → choose template → review sender, recipients, skipped contacts, warnings and the rendered message → tick the confirmation → send. Jobs run sequentially on the server with a random pause *between* emails only; progress and per-recipient results come from the database.
- **Email History** — counts, search, status/date filters, job details, retry of *definitely failed, retryable* recipients. “Sent” = accepted by the provider, not inbox delivery.

## Safety behaviour
- One active job per user (database-enforced); idempotency keys prevent duplicate submissions; an in-flight recipient is never attempted twice.
- Outcomes after a timeout/crash are recorded as `OUTCOME_UNKNOWN` and are **never** auto-retried (the provider may have accepted them). Jobs interrupted by a restart are closed on next boot.
- Unresolved placeholders block sending unless the field explicitly allows empty. Values are HTML-escaped; email HTML is sanitized; previews render only in a fully sandboxed iframe.
- Cross-user access returns 404; this is covered by automated tests.
- Please only contact recruiters about relevant roles, honour opt-outs, and avoid repeated unsolicited messages (the starter template includes an opt-out line; the dialog warns if you already emailed an address).

## Data, retention and privacy
| Data | Where | Retention / deletion |
|---|---|---|
| Contacts | `recruitercontacts` | Until you delete them (row, bulk, or per import). |
| Imports | `imports` (metadata: filename, sheet, counts, row errors ≤200, logical `storageRef`) | Uploaded files are **not stored**; only parsed rows you accept are saved. Metadata kept until you delete the import record. |
| Templates | `emailtemplates` | Until deleted. |
| Jobs & history | `emailjobs`, `emailhistory` | Kept as an audit log: recipient snapshot (name, company, email, role, link), subject, status, safe error, provider message id. A job also keeps one copy of the *unpersonalised* template and resolved profile values so retries are identical; **personalised message bodies are not stored.** Removed with the account. |
| Sender credential | `users.emailIdentity.credential` (encrypted) | Until you remove the sender or delete the account. |
| Profile photo | `UPLOAD_DIR/avatars/<generated name>` (mode 0600, owner-only endpoint) | Replaced/removed on change or account deletion. |
| Sessions | `sessions` (token hash only, TTL index) | Idle/max policy above; deleted on logout and password change. |
| OTP codes / OAuth state | `otpcodes` (HMAC only), `oauthstates` | Minutes-long validity; purged by TTL indexes (OTP records kept a day for rate limiting). |

Profile → **Export my data** downloads everything you own as JSON; **Delete account** (password required) permanently removes all of the above.
There is no automatic history expiry yet; add a TTL index on `emailhistory.createdAt` if you need one.

## Scripts
Backend: `npm run dev | build | start | typecheck | lint | test | db:init`. Frontend: `npm run dev | build | typecheck | lint | test`.
(TypeScript is pinned to 6.x because typescript-eslint does not support 7.0 yet.)

## Known gaps
- Gmail OAuth / other providers are not implemented (App Password SMTP only). No automatic domain checks beyond the SMTP login proof.
- `.xls` import is accepted via SheetJS but only `.xlsx` and `.json` are covered by tests.
- No dedicated password-reset email (use Email OTP, then set a new password), and no per-account lockout beyond IP rate limits and the per-email OTP limits.
- Google OAuth and OTP email delivery were **tested only with stubs** (and the unit/integration tests). They are unverified against real Google credentials or a real SMTP provider until you configure and try them.
- Single-process job runner: a job runs in the API process (restart-safe via recovery, not horizontally scaled).
- No automatic retention/expiry of history; Atlas itself was not configured by this code (see manual steps above).
