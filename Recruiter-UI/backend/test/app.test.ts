import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { EmailJobService } from "../src/services/emailJobService.js";
import { renderEmail } from "../src/services/emailTemplateService.js";
import { readWorkbook } from "../src/services/workbookService.js";
import { HEADER, writeWorkbook } from "./helpers.js";

const baseEnv = {
  SENDER_NAME: "Sam Sender", SENDER_EMAIL: "sam@example.com", SENDER_PASS: "secret-pass-123",
  CONTACT_NO: "123", RESUME_LINK: "https://r.example/cv", LINKEDIN_LINK: "https://l.example/in",
};
const rows = [
  HEADER,
  ["Jane Doe", "Acme", "jane@example.com", "Lead", null, null],
  ["Bob <b>", "Evil & Co", "bob@example.com", "Dev", "https://x.example", "no"],
  ["No Email", "Acme", null, "Dev", null, null],
  ["Bad Mail", "Acme", "not-an-email", "Dev", null, null],
  ["Jane Again", "Acme", "JANE@example.com", "Dev", null, "Yes"],
  [],
  ["Num Row", "Acme", "num@example.com", "Dev", 12345, 1],
];
const template = { subject: "Hi {{Role}} at {{Company}}", html: "<p>Hi {{firstName}} from {{Company}} {{Bogus}}</p>" };

function setup(opts: { rows?: unknown[][]; env?: Record<string, string>; mailer?: { send: ReturnType<typeof vi.fn> } } = {}) {
  const file = writeWorkbook(opts.rows ?? rows);
  const config = loadConfig({ ...baseEnv, EXCEL_PATH: file, ...opts.env } as NodeJS.ProcessEnv);
  const mailer = opts.mailer ?? { send: vi.fn().mockResolvedValue(undefined) };
  const sleep = vi.fn().mockResolvedValue(undefined);
  const jobs = new EmailJobService({ mailer: { ...mailer, close() {} } as never, getSender: () => config, sleep, random: () => 0 });
  return { app: createApp(config, jobs), jobs, mailer, sleep, config };
}

describe("workbook", () => {
  it("normalizes rows and keeps Excel row numbers", () => {
    const { config } = setup();
    const wb = readWorkbook(config);
    expect(wb.items.map((r) => r.id)).toEqual(["row-2", "row-3", "row-4", "row-5", "row-6", "row-8"]);
    expect(wb.items[0]).toMatchObject({ Link: null, isSend: null });
    expect(wb.items.at(-1)).toMatchObject({ Link: "12345", isSend: "1" });
    expect(wb.source.fileName).toBe("recruiters.xlsx");
  });
  it("reports missing columns, missing sheet and missing config", async () => {
    const a = setup({ rows: [["Name", "Company"], ["a", "b"]] });
    const r1 = await request(a.app).get("/api/recruiters");
    expect(r1.status).toBe(500);
    expect(r1.body.error).toMatchObject({ code: "MISSING_COLUMNS", details: ["Email", "Role"] });
    const b = setup({ env: { SHEET_NAME: "Nope" } });
    expect((await request(b.app).get("/api/recruiters")).body.error.code).toBe("SHEET_NOT_FOUND");
    const c = setup({ env: { EXCEL_PATH: "" } });
    const r3 = await request(c.app).get("/api/recruiters");
    expect(r3.body.error.code).toBe("WORKBOOK_NOT_CONFIGURED");
    const d = setup({ env: { EXCEL_PATH: "/definitely/missing.xlsx" } });
    const r4 = await request(d.app).get("/api/recruiters");
    expect(r4.body.error.code).toBe("WORKBOOK_UNREADABLE");
    expect(JSON.stringify(r4.body)).not.toContain("/definitely");
  });
});

describe("template rendering", () => {
  it("substitutes, escapes html values, keeps unknown tokens and warns", () => {
    const { config } = setup();
    const r = readWorkbook(config).items[1];
    const out = renderEmail(r, { subject: "{{Company}} {{Role}}", html: "<i>{{Name}} {{Nope}} {{LINKEDIN_LINK}}</i>" }, config);
    expect(out.subject).toBe("Evil & Co Dev");
    expect(out.html).toBe("<i>Bob &lt;b&gt; {{Nope}} https://l.example/in</i>");
    expect(out.warnings).toContain("Unknown placeholder: {{Nope}}");
  });
  it("does not re-expand placeholders inside values", () => {
    const { config } = setup();
    const r = { ...readWorkbook(config).items[0], Company: "{{SENDER_EMAIL}}" };
    expect(renderEmail(r, { subject: "s", html: "{{Company}}" }, config).html).toBe("{{SENDER_EMAIL}}".replace(/\{/g, "{"));
  });
});

describe("API", () => {
  it("health + recruiters never leak credentials", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/health")).body).toEqual({ status: "ok", service: "recruiter-outreach-api" });
    const res = await request(app).get("/api/recruiters");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("secret-pass");
  });
  it("preview does not send and flags problems", async () => {
    const { app, mailer } = setup();
    const res = await request(app).post("/api/emails/preview").send({ recruiterIds: ["row-2", "row-5"], template });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ to: "jane@example.com", subject: "Hi Lead at Acme" });
    expect(res.body.items[0].warnings).toContain("Unknown placeholder: {{Bogus}}");
    expect(res.body.items[1].warnings).toContain("Email address is malformed");
    expect(mailer.send).not.toHaveBeenCalled();
  });
  it("rejects malformed requests", async () => {
    const { app } = setup();
    const bad = [
      { recruiterIds: [], template },
      { recruiterIds: ["row-2"], template: { subject: "", html: "x" } },
      { recruiterIds: ["abc"], template },
    ];
    for (const b of bad) expect((await request(app).post("/api/emails/preview").send(b)).status).toBe(400);
    const unknown = await request(app).post("/api/emails/preview").send({ recruiterIds: ["row-99"], template });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("RECRUITER_NOT_FOUND");
    const junk = await request(app).post("/api/emails/preview").set("Content-Type", "application/json").send("{oops");
    expect(junk.status).toBe(400);
    expect((await request(app).get("/api/emails/jobs/nope")).status).toBe(404);
  });
  it("requires confirmation === true", async () => {
    const { app, mailer } = setup();
    for (const confirmation of [undefined, false, "true", 1]) {
      const res = await request(app).post("/api/emails/send").send({ recruiterIds: ["row-2"], template, confirmation });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CONFIRMATION_REQUIRED");
    }
    expect(mailer.send).not.toHaveBeenCalled();
  });
  it("refuses to send when SMTP is not configured", async () => {
    const { app } = setup({ env: { SENDER_PASS: "" } });
    const res = await request(app).post("/api/emails/send").send({ recruiterIds: ["row-2"], template, confirmation: true });
    expect(res.status).toBe(503);
    expect(res.body.error.details).toEqual(["SENDER_PASS"]);
  });
});

describe("sending", () => {
  it("applies skip rules, dedupes, and delays only between sends", async () => {
    const { app, jobs, mailer, sleep } = setup();
    const ids = ["row-2", "row-2", "row-3", "row-4", "row-5", "row-6", "row-8"];
    const res = await request(app).post("/api/emails/send").send({
      recruiterIds: ids, template, confirmation: true,
      options: { delayMinMs: 0, delayMaxMs: 0, skipRowsMarkedNo: true },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "queued", total: 6 });
    await jobs.idle();
    const job = (await request(app).get(`/api/emails/jobs/${res.body.jobId}`)).body;
    const by = Object.fromEntries(job.results.map((r: { recruiterId: string; status: string }) => [r.recruiterId, r.status]));
    expect(by).toEqual({ "row-2": "sent", "row-3": "skipped", "row-4": "skipped", "row-5": "skipped", "row-6": "skipped", "row-8": "sent" });
    expect(job).toMatchObject({ status: "completed", sent: 2, skipped: 4, failed: 0 });
    expect(mailer.send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // between two sends, not after the last
    expect(sleep.mock.calls[0][0]).toBe(30_000); // zero delay is clamped up
    const list = (await request(app).get("/api/recruiters")).body.items;
    expect(list.find((r: { id: string }) => r.id === "row-2").status).toBe("sent");
    expect(list.find((r: { id: string }) => r.id === "row-3").status).toBe("skipped");
  });
  it("records sanitized failures", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("535 user sam@example.com pass secret-pass-123"), { code: "EAUTH" }));
    const { app, jobs } = setup({ mailer: { send } });
    const res = await request(app).post("/api/emails/send").send({ recruiterIds: ["row-2"], template, confirmation: true });
    await jobs.idle();
    const job = (await request(app).get(`/api/emails/jobs/${res.body.jobId}`)).body;
    expect(job).toMatchObject({ status: "failed", failed: 1 });
    expect(JSON.stringify(job)).not.toContain("secret-pass");
  });
  it("reports partial failure and blocks concurrent jobs for the same recipient", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn().mockImplementationOnce(() => gate).mockRejectedValueOnce(new Error("x"));
    const { app, jobs } = setup({ mailer: { send } });
    const first = await request(app).post("/api/emails/send").send({ recruiterIds: ["row-2", "row-8"], template, confirmation: true });
    const dup = await request(app).post("/api/emails/send").send({ recruiterIds: ["row-8"], template, confirmation: true });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("RECIPIENT_BUSY");
    release();
    await jobs.idle();
    const job = (await request(app).get(`/api/emails/jobs/${first.body.jobId}`)).body;
    expect(job).toMatchObject({ status: "completed_with_errors", sent: 1, failed: 1 });
  });
});
