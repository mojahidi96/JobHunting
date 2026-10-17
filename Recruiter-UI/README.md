# Recruiter Outreach Mailer

React dashboard + Express API wrapped around the existing `recruiter-outreach-mailer/sendEmails.js` workflow
(Gmail SMTP, Excel sheet `Recruiters_Email`). The original script is untouched.
The interface between the two apps is defined in [API_CONTRACT.md](API_CONTRACT.md).

## Setup

One command (UI on http://localhost:5173, `/api` proxied to the backend on :4000):

```bash
cp backend/.env.example backend/.env   # fill in values
npm run install:all && npm run dev
```

Or separately:

Requires Node 20+.

```bash
# backend
cd backend && cp .env.example .env   # fill in values
npm install && npm run dev           # http://localhost:4000/api

# frontend (second terminal)
cd frontend && cp .env.example .env
npm install && npm run dev           # http://localhost:5173
```

### Backend environment (`backend/.env`)
| Variable | Notes |
|---|---|
| `EXCEL_PATH` | Workbook path (relative to where the server starts, i.e. `backend/`). Never returned by the API. |
| `SHEET_NAME` | Defaults to `Recruiters_Email`. Required columns: Name, Company, Email, Role. Optional: Link, isSend. |
| `SENDER_NAME`, `SENDER_EMAIL`, `SENDER_PASS`, `CONTACT_NO`, `RESUME_LINK`, `LINKEDIN_LINK` | Sender details. `SENDER_PASS` must be a Gmail **App Password** (Google Account → Security → 2-Step Verification → App passwords), not your normal password. |
| `PORT`, `CORS_ORIGIN` | Default `4000` and `http://localhost:5173`. |

Frontend: `VITE_API_BASE_URL` (default `/api`, served through the Vite proxy; set `http://localhost:4000/api` to bypass it).

## Scripts
`npm run dev | build | start | test | typecheck` in `backend/`; `npm run dev | build | test | typecheck` in `frontend/`.

## Behaviour
- The workbook is re-read on every request, so edits to the file show up after Refresh. It is never modified.
- Rows with `isSend = no`, missing required fields, invalid or duplicate addresses are skipped.
- Sends run in a background job, one at a time, with a random 45–90 s pause **between** emails only.
  Delay values from clients are clamped to 30–300 s.
- Delivery status and job history are **in memory** and are lost when the server restarts. They are not written back to Excel.
- Only one running job may target a given address at a time (409 `RECIPIENT_BUSY`).
- Recruiter values are HTML-escaped when inserted into the body. Credentials are never returned or logged.
- No authentication: run this locally only.
- The default template is the one from `sendEmails.js`. It has no opt-out line; consider adding one
  (e.g. "Reply 'no' if you'd rather not hear from me") and keep outreach individual and relevant.
- The default template lives in `frontend/src/defaultTemplate.ts` (the contract has no endpoint for it).

## curl examples
```bash
curl -s localhost:4000/api/emails/preview -H 'content-type: application/json' -d '{
  "recruiterIds":["row-2"],
  "template":{"subject":"Request for an Interview Opportunity - {{Role}} at {{Company}}","html":"<p>Hi {{firstName}},</p>"}}'

curl -s localhost:4000/api/emails/send -H 'content-type: application/json' -d '{
  "recruiterIds":["row-2"],
  "template":{"subject":"Hello {{firstName}}","html":"<p>Hi {{firstName}}</p>"},
  "options":{"delayMinMs":45000,"delayMaxMs":90000,"skipRowsMarkedNo":true},
  "confirmation":true}'

curl -s localhost:4000/api/emails/jobs/<jobId>
```

Test with a small list of your own addresses before real outreach.
