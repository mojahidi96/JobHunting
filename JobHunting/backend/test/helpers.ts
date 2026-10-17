import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import xlsx from "xlsx";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { connectDb, syncIndexes } from "../src/db/connect.js";
import { JobRunner } from "../src/services/jobRunner.js";
import type { AuthMailer } from "../src/services/authMailer.js";
import type { GoogleClaims, GoogleClient } from "../src/services/googleService.js";
import type { MailMessage, MailerFactory, SenderCredentials } from "../src/services/mailService.js";

export interface FakeMail {
  sent: (MailMessage & { from: string })[];
  verifyCalls: number;
  failFor: Map<string, unknown>; // recipient email -> error to throw
  verifyError: unknown;
  gate: Promise<void> | null; // when set, send() waits for it
  creds: SenderCredentials[];
}

export async function setup() {
  const mongod = await MongoMemoryServer.create();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-uploads-"));
  const config = loadConfig({
    NODE_ENV: "test", MONGODB_URI: mongod.getUri("jobhunting_test"), ENCRYPTION_KEY: randomBytes(32).toString("base64"), UPLOAD_DIR: uploadDir,
  } as NodeJS.ProcessEnv);
  await connectDb(config.mongoUri);
  await syncIndexes();

  const mail: FakeMail = { sent: [], verifyCalls: 0, failFor: new Map(), verifyError: null, gate: null, creds: [] };
  const mailerFactory: MailerFactory = (c) => {
    mail.creds.push(c);
    return {
      async verify() { mail.verifyCalls++; if (mail.verifyError) throw mail.verifyError; },
      async send(m) {
        if (mail.gate) await mail.gate;
        const err = mail.failFor.get(m.to);
        if (err) throw err;
        mail.sent.push({ ...m, from: `${c.senderName} <${c.senderEmail}>` });
        return { messageId: `<id-${mail.sent.length}@test>` };
      },
      close() {},
    };
  };
  const authMail = { sent: [] as { to: string; code: string }[], fail: false };
  const authMailer: AuthMailer = {
    async sendOtp(to, code) { if (authMail.fail) throw new Error("smtp down"); authMail.sent.push({ to, code }); },
    close() {},
  };
  // Fake Google: `google.next` is what the "provider" will assert for the next code exchange.
  const google = { next: null as GoogleClaims | null, lastAuth: null as { state: string; nonce: string; codeChallenge: string } | null, failExchange: false };
  const googleClient: GoogleClient = {
    authUrl(p) { google.lastAuth = p; return `https://accounts.example/auth?state=${p.state}`; },
    async exchange() {
      if (google.failExchange || !google.next) throw new Error("exchange failed");
      return { ...google.next, nonce: google.next.nonce ?? google.lastAuth!.nonce };
    },
  };
  const runner = new JobRunner({ config, mailerFactory, sleep: async () => {}, random: () => 0 });
  const app = createApp({ config, mailerFactory, runner, googleClient, authMailer });

  const teardown = async () => {
    await runner.idle();
    await mongoose.disconnect();
    await mongod.stop();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  };
  return { app, config, mail, authMail, google, runner, uploadDir, teardown };
}

export type TestCtx = Awaited<ReturnType<typeof setup>>;

/** A signed-in client: cookie jar + CSRF header handled automatically. */
export async function newUser(ctx: TestCtx, name = "Test User", email = `u${Math.random().toString(36).slice(2)}@example.com`) {
  const agent = request.agent(ctx.app);
  const res = await agent.post("/api/auth/register").send({ name, email, password: "correct horse battery 1" });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  const csrf: string = res.body.csrfToken;
  const wrap = (m: "post" | "put" | "patch" | "delete") => (url: string) => (agent as any)[m](url).set("X-CSRF-Token", csrf);
  return {
    email, id: res.body.user.id as string, csrf, agent,
    get: (url: string) => agent.get(url),
    post: wrap("post"), put: wrap("put"), patch: wrap("patch"), del: wrap("delete"),
  };
}
export type Client = Awaited<ReturnType<typeof newUser>>;

export function xlsxBuffer(rows: unknown[][], sheet = "Recruiters_Email"): Buffer {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), sheet);
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

/** Configure + verify a sender for the user (uses the fake mailer, no network). */
export async function verifiedSender(c: Client, senderEmail = `${c.email}`) {
  await c.put("/api/settings/email").send({ senderName: "Sender Name", senderEmail, appPassword: "abcd efgh ijkl mnop" }).expect(200);
  const r = await c.post("/api/settings/email/test").expect(200);
  if (r.body.settings.status !== "verified") throw new Error("sender not verified");
}

export async function addContact(c: Client, over: Record<string, unknown> = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const r = await c.post("/api/recruiters").send({ Name: `Rec ${n}`, Company: "Acme", Email: `${n}@acme.test`, Role: "Engineer", ...over }).expect(201);
  return r.body.item as { id: string; Email: string };
}

export async function waitForJob(ctx: TestCtx, c: Client, jobId: string) {
  await ctx.runner.idle();
  return (await c.get(`/api/emails/jobs/${jobId}`).expect(200)).body as { job: any; recipients: any[] };
}

/** Marks the default template reviewed and returns it. */
export async function reviewedDefaultTemplate(c: Client) {
  const list = (await c.get("/api/email-templates").expect(200)).body.items as any[];
  const t = list.find((x) => x.isDefault)!;
  await c.post(`/api/email-templates/${t.id}/review`).send({ confirmation: true, version: t.version }).expect(200);
  return t as { id: string; version: number };
}

export async function fillProfile(c: Client) {
  await c.patch("/api/profile").send({
    phone: "+1 555 0100", headline: "a Senior Engineer", skillsSummary: "TypeScript, Node.js",
    resumeUrl: "https://example.com/resume", linkedinUrl: "https://linkedin.com/in/test", experienceYears: 8,
  }).expect(200);
}
