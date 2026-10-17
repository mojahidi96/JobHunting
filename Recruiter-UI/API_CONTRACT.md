# API Contract — Recruiter Outreach Mailer

Single source of truth for `backend/` and `frontend/`. Change this file first, then both sides.

- Dev base URL: `http://localhost:4000/api` (frontend: `VITE_API_BASE_URL`, default `/api` via the Vite dev proxy to this URL; backend: `PORT`, default 4000).
- All bodies are JSON. Request bodies are limited to 100 kB.

## Types

```ts
type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

type Recruiter = {
  id: string;          // "row-<rowNumber>", valid for the workbook as currently saved
  rowNumber: number;   // 1-based Excel row; header is row 1, so data starts at 2
  Name: string; Company: string; Email: string; Role: string;
  Link: string | null; isSend: string | null;   // source columns; blank -> null
  status: DeliveryStatus;   // live delivery status (in memory, reset on server restart)
  lastError?: string; sentAt?: string;
};

type EmailTemplate = { subject: string; html: string };
type JobStatus = "queued" | "running" | "completed" | "completed_with_errors" | "failed";
type ApiErrorBody = { error: { code: string; message: string; details?: unknown[] } };
```

`isSend` is source data, not delivery status. A row whose `isSend` is `no` (case-insensitive) is skipped by default.

## Placeholders

`{{Name}} {{firstName}} {{Company}} {{Role}} {{Email}} {{Link}} {{SENDER_NAME}} {{SENDER_EMAIL}} {{CONTACT_NO}} {{RESUME_LINK}} {{LINKEDIN_LINK}}`

Applied by the backend to subject and html. `firstName` = first non-empty token of `Name`. `Link` is `""` when missing.
Values are HTML-escaped in `html`, raw in `subject`. Unknown `{{tokens}}` stay in the output and add a warning.
Preview and send share the same rendering code.

## Endpoints

### GET /api/health
`200 { "status": "ok", "service": "recruiter-outreach-api" }`

### GET /api/recruiters
`200 { items: Recruiter[], source: { fileName, sheetName }, warnings: string[] }`
Errors: `WORKBOOK_NOT_CONFIGURED` (500), `WORKBOOK_UNREADABLE` (500), `SHEET_NOT_FOUND` (500), `MISSING_COLUMNS` (500, `details` lists names).

### POST /api/emails/preview
Request `{ recruiterIds: string[], template: EmailTemplate }`
`200 { items: { recruiterId, to, subject, html, warnings: string[] }[] }`. Never sends.
Errors: `VALIDATION_ERROR` (400), `RECRUITER_NOT_FOUND` (404, ids in `details`).

### POST /api/emails/send
Request
```json
{ "recruiterIds": ["row-2"], "template": { "subject": "...", "html": "..." },
  "options": { "delayMinMs": 45000, "delayMaxMs": 90000, "skipRowsMarkedNo": true },
  "confirmation": true }
```
`options` is optional. `confirmation` must be exactly `true`. Recipients are resolved from the workbook only.
Delays are clamped server-side to 30 000–300 000 ms. Delay happens only between eligible sends.
Duplicate ids are collapsed. Rows with a duplicate address, an invalid address, missing required fields, or `isSend = no` (when `skipRowsMarkedNo`) are kept in the job as `skipped` with an `error` reason.
`202 { jobId, status: "queued", total, message }` (`total` = unique recruiter ids in the job, including skipped ones).
Errors: `VALIDATION_ERROR` (400), `CONFIRMATION_REQUIRED` (400), `RECRUITER_NOT_FOUND` (404),
`RECIPIENT_BUSY` (409, another running job targets the same address), `SMTP_NOT_CONFIGURED` (503).

### GET /api/emails/jobs/:jobId
`200 { jobId, status: JobStatus, total, sent, failed, skipped, results: { recruiterId, email, status: DeliveryStatus, error? }[] }`
Error: `JOB_NOT_FOUND` (404). Jobs are in memory and are lost on restart.

## Errors
Always `ApiErrorBody`. No stack traces, absolute paths or credentials.
