# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Multi-user recruiter-outreach app: React 19 + Vite + Tailwind v4 UI (`frontend/`), Express 5 + Mongoose API (`backend/`), MongoDB Atlas. ESM + TypeScript throughout (TypeScript is pinned to 6.x because typescript-eslint does not support 7.0). `README.md` has Atlas setup, env vars and data-retention details.

## Commands
Root: `npm run install:all`, `npm run dev` (API :4000 + UI :5173, Vite proxies `/api`), `npm run lint | test | build | db:init`.

Backend (`cd backend`): `npm run dev | typecheck | lint | test | build | db:init`
- Single test: `npx vitest run test/sending.test.ts -t "idempotent"`
- Config is validated at startup and needs `MONGODB_URI` and `ENCRYPTION_KEY` (see `.env.example`). Tests do **not** use `.env` or Atlas: `test/helpers.ts` boots `mongodb-memory-server` with explicit env, plus a fake mailer and `JobRunner` with a no-op sleep.
- `npm run db:init` creates collections/indexes in Atlas (fails with a clear message if the IP isn't allowlisted).

Frontend (`cd frontend`): `npm run dev | typecheck | lint | test | build`; single test: `npx vitest run src/test/app.test.tsx -t "grid"`. Tests stub `fetch`.

## Architecture
- **Contract first:** `docs/API_CONTRACT.md` is the source of truth. Frontend mirrors it in `frontend/src/types.ts` + `api.ts`; backend produces DTOs only via `backend/src/lib/dto.ts` (never return raw Mongoose docs). Change the contract, then both sides.
- **Auth/ownership:** `middleware/auth.ts` resolves the HttpOnly session cookie (hashed token in `sessions`), enforces server-side expiry (`lastActiveAt` idle window + absolute `expiresAt`; requests with `X-Background: 1` do not count as activity), and requires a per-session `X-CSRF-Token` header plus Origin check on non-GET. Sign-in methods (password, OTP via `otpService`, Google via `googleService`) all converge in `accountService.resolveVerifiedIdentity`, which links accounts only on a freshly verified email and drops an unverified account's password. Google/OTP delivery are injected (`createApp` deps), so tests use fakes (`test/helpers.ts`). Every query must filter by `req.auth.userId`; foreign ids must look like 404. Several endpoints use zod `.strict()` on purpose so client-supplied `from`/`to`/`userId` are rejected.
- **Send pipeline** (spans several files): `routes/emails.ts` → `services/sendService.ts` (`prepare()` resolves contacts server-side, renders via `services/templateEngine.ts`, computes blocking `problems`; `createJob()` persists job + one `emailhistory` row per recipient) → `services/jobRunner.ts` (sequential loop, atomically claims each pending row, delay only *between* sends, decrypts the sender credential per job). Preview and send share `prepare()`/the renderer.
- **Safety invariants to preserve:** one active job per user (partial unique index on `emailjobs {userId, active:true}`); idempotency via unique `{userId, idempotencyKey}`; a recipient is never attempted twice; timeouts/crashes become `OUTCOME_UNKNOWN` with `retryable:false` (`safeSendError` in `mailService.ts`, `finalizeJob`/`recoverInterruptedJobs` in `jobRunner.ts`); sending requires a *verified* sender and a template whose `reviewedVersion === version` (any material edit bumps `version`).
- **Templates:** placeholder values resolve by `placeholderConfig[token]` → built-in default → unknown. Unresolved values block sending unless `allowEmpty`. Values are HTML-escaped, output is run through `sanitizeEmailHtml`, and the UI only renders it in a fully sandboxed iframe (`PreviewFrame`).
- **Sender identity** (`users.emailIdentity`) is separate from the login email; the Gmail app password is AES-256-GCM encrypted (`lib/crypto.ts`, key from `ENCRYPTION_KEY`) and never returned or logged.
- **Imports** (`services/importService.ts`) are stateless: preview and import both re-parse the uploaded file; files are never stored, only `imports` metadata with a logical `storageRef`. Exports neutralise spreadsheet formulas.
- Frontend: routing in `App.tsx` gates by auth → onboarding → app; auth/CSRF state is memory-only in `auth.tsx` + `api.ts` (global 401 handler → "session expired" notice); styling is Tailwind with semantic tokens in `styles/app.css` (class-based dark mode via `theme.tsx`, pre-paint script in `index.html`) and primitives in `components/ui.tsx`; use `useConfirm()`/`usePrompt()` (`components/confirm.tsx`) instead of `window.confirm`/`prompt`; use `X-Background` (api `background` flag) for any new polling; shared `TemplateEditor` and `SendDialog` modals are used from Dashboard, Templates and Recruiters pages.
- `../recruiter-outreach-mailer/` is the original standalone script (separate, untracked repo); this app no longer reads any fixed Excel path.
