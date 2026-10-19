import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuditLog, OtpCode, User } from "../src/models/index.js";
import { createConfiguredAuthMailer } from "../src/services/authMailer.js";
import { initAuthorization } from "../src/services/ownerService.js";
import { addContact, fillProfile, newUser, otpUser, reviewedDefaultTemplate, setup, verifiedSender, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.teardown(); });

const OWNER = "owner@example.com";
const uniq = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}@example.com`;

describe("owner bootstrap and role assignment", () => {
  it("public registration cannot set a role, and a password sign-up with the owner address gets no privileges", async () => {
    const r = await request(ctx.app).post("/api/auth/register").send({ name: "X", email: uniq("a"), password: "correct horse battery 1", role: "admin" });
    expect(r.status).toBe(400);
    const squatter = await newUser(ctx, "Squatter", OWNER); // unverified password account on the owner's address
    expect(squatter.agent && (await squatter.get("/api/auth/me")).body.user.role).toBe("candidate");
    await squatter.get("/api/admin/users").expect(403);
    await User.deleteOne({ email: OWNER });
  });

  it("grants Admin/owner server-side only after the owner's email is verified", async () => {
    const owner = await otpUser(ctx, OWNER);
    expect(owner.user.role).toBe("admin");
    expect(owner.user.isOwner).toBe(true);
    await owner.get("/api/admin/users").expect(200);
    expect(await AuditLog.countDocuments({ action: "owner.bootstrap" })).toBeGreaterThan(0);
  });

  it("startup migration backfills legacy accounts and strips a stray owner flag", async () => {
    const legacy = await User.collection.insertOne({ name: "Legacy", email: uniq("l"), emailVerified: true, isOwner: true, createdAt: new Date(), updatedAt: new Date() });
    await initAuthorization(ctx.config);
    const u = await User.findById(legacy.insertedId).lean();
    expect(u).toMatchObject({ role: "candidate", status: "active", isOwner: false });
  });
});

describe("authorization", () => {
  it("denies unauthenticated and candidate access to every admin endpoint", async () => {
    const cand = await newUser(ctx);
    const probes: [string, string][] = [
      ["get", "/api/admin/users"], ["get", `/api/admin/users/${cand.id}`], ["get", "/api/admin/audit"], ["get", "/api/admin/settings/email"],
      ["patch", `/api/admin/users/${cand.id}/role`], ["patch", `/api/admin/users/${cand.id}/status`], ["put", "/api/admin/settings/email"], ["post", "/api/admin/settings/email/test"],
    ];
    for (const [m, url] of probes) {
      const anon = await (request(ctx.app) as any)[m](url).send({});
      expect(anon.status, `${m} ${url} anon`).toBe(401);
      const c = m === "get" ? await cand.get(url) : await (cand as any)[m === "patch" ? "patch" : m === "put" ? "put" : "post"](url).send({ role: "admin", status: "suspended" });
      expect(c.status, `${m} ${url} candidate`).toBe(403);
    }
  });

  it("only the owner can promote; a promoted admin cannot promote, demote the owner, or touch settings", async () => {
    const owner = await otpUser(ctx, OWNER);
    const target = await otpUser(ctx, uniq("t"));
    const other = await otpUser(ctx, uniq("o"));
    await owner.patch(`/api/admin/users/${target.id}/role`).send({ role: "admin" }).expect(200);
    // The promoted admin is an admin but not an owner.
    expect((await target.get("/api/auth/me")).body.user.role).toBe("admin");
    await target.get("/api/admin/users").expect(200);
    expect((await target.patch(`/api/admin/users/${other.id}/role`).send({ role: "admin" })).body.error.code).toBe("OWNER_ONLY");
    await target.get("/api/admin/settings/email").expect(403);
    const ownerRow = await User.findOne({ email: OWNER });
    expect((await target.patch(`/api/admin/users/${ownerRow!.id}/role`).send({ role: "candidate" })).status).toBe(403);
    // Owner protections.
    expect((await owner.patch(`/api/admin/users/${ownerRow!.id}/role`).send({ role: "candidate" })).body.error.code).toBe("OWNER_PROTECTED");
    expect((await owner.patch(`/api/admin/users/${ownerRow!.id}/status`).send({ status: "suspended" })).body.error.code).toBe("OWNER_PROTECTED");
    expect((await owner.del("/api/account").send({ confirm: true, confirmEmail: OWNER })).body.error.code).toBe("OWNER_PROTECTED");
    // Demote works and takes effect on the very next request.
    await owner.patch(`/api/admin/users/${target.id}/role`).send({ role: "candidate" }).expect(200);
    await target.get("/api/admin/users").expect(403);
    const acts = (await AuditLog.find({ targetId: target.id }).lean()).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(["role.promote", "role.demote"]));
  });

  it("refuses to promote unverified or suspended accounts, self-change, bad ids and extra fields", async () => {
    const owner = await otpUser(ctx, OWNER);
    const pw = await newUser(ctx); // unverified password account
    expect((await owner.patch(`/api/admin/users/${pw.id}/role`).send({ role: "admin" })).body.error.code).toBe("EMAIL_UNVERIFIED");
    expect((await owner.patch(`/api/admin/users/${owner.id}/role`).send({ role: "candidate" })).body.error.code).toBe("OWNER_PROTECTED");
    expect((await owner.patch("/api/admin/users/not-an-id/role").send({ role: "admin" })).status).toBe(400);
    expect((await owner.patch(`/api/admin/users/${pw.id}/role`).send({ role: "admin", extra: 1 })).status).toBe(400);
    expect((await owner.patch("/api/admin/users/aaaaaaaaaaaaaaaaaaaaaaaa/role").send({ role: "admin" })).status).toBe(404);
  });

  it("the profile API cannot be used to escalate privileges", async () => {
    const c = await newUser(ctx);
    await c.patch("/api/profile").send({ role: "admin" }).expect(400);
    expect((await User.findById(c.id).lean())!.role).toBe("candidate");
  });
});

describe("account status", () => {
  it("suspending ends sessions immediately and blocks every sign-in method; reactivating restores access", async () => {
    const owner = await otpUser(ctx, OWNER);
    const email = uniq("s");
    const victim = await otpUser(ctx, email);
    await owner.patch(`/api/admin/users/${victim.id}/status`).send({ status: "suspended" }).expect(200);
    expect((await victim.get("/api/auth/me")).status).toBe(401); // sessions were revoked
    await OtpCode.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    await request(ctx.app).post("/api/auth/otp/request").send({ email }).expect(200);
    const code = [...ctx.authMail.sent].reverse().find((m) => m.to === email)!.code;
    const blocked = await request(ctx.app).post("/api/auth/otp/verify").send({ email, code });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("ACCOUNT_SUSPENDED");
    await owner.patch(`/api/admin/users/${victim.id}/status`).send({ status: "active" }).expect(200);
    await otpUser(ctx, email);
  });

  it("a non-owner admin can suspend candidates but not another admin", async () => {
    const owner = await otpUser(ctx, OWNER);
    const adm = await otpUser(ctx, uniq("adm"));
    const adm2 = await otpUser(ctx, uniq("adm"));
    const cand = await otpUser(ctx, uniq("c"));
    await owner.patch(`/api/admin/users/${adm.id}/role`).send({ role: "admin" }).expect(200);
    await owner.patch(`/api/admin/users/${adm2.id}/role`).send({ role: "admin" }).expect(200);
    await adm.patch(`/api/admin/users/${cand.id}/status`).send({ status: "suspended" }).expect(200);
    expect((await adm.patch(`/api/admin/users/${adm2.id}/status`).send({ status: "suspended" })).status).toBe(403);
    expect((await adm.patch(`/api/admin/users/${adm.id}/status`).send({ status: "suspended" })).body.error.code).toBe("SELF_CHANGE");
  });
});

describe("candidate directory", () => {
  it("searches, filters, sorts and paginates without leaking secrets", async () => {
    const owner = await otpUser(ctx, OWNER);
    for (let i = 0; i < 3; i++) await newUser(ctx, `Zed Searchable ${i}`, uniq("zz"));
    const all = (await owner.get("/api/admin/users?pageSize=2&page=1&sort=name&order=asc")).body;
    expect(all.items).toHaveLength(2);
    expect(all.total).toBeGreaterThan(3);
    const s = (await owner.get("/api/admin/users?q=Zed%20Searchable")).body;
    expect(s.total).toBe(3);
    expect((await owner.get("/api/admin/users?q=.*")).body.total).toBe(0); // regex input is escaped
    expect((await owner.get("/api/admin/users?role=admin")).body.items.every((u: any) => u.role === "admin")).toBe(true);
    expect((await owner.get("/api/admin/users?status=suspended")).body.items.every((u: any) => u.status === "suspended")).toBe(true);
    expect((await owner.get("/api/admin/users?sort=passwordHash")).status).toBe(400);
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/passwordHash|codeHash|credential|\$argon2/);
    const detail = (await owner.get(`/api/admin/users/${s.items[0].id}`)).body;
    expect(detail.user.hasPassword).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/passwordHash|\$argon2|credential/);
    const audit = (await owner.get("/api/admin/audit")).body;
    expect(audit.total).toBeGreaterThan(0);
  });
});

describe("email delivery settings (owner only)", () => {
  it("stores the password encrypted, never returns it, tests safely and logs the change", async () => {
    const owner = await otpUser(ctx, OWNER);
    const secret = "super-secret-app-password-123";
    const body = { host: "smtp.gmail.com", port: 465, secure: true, user: OWNER, from: `JobHunting <${OWNER}>`, pass: secret };
    await owner.put("/api/admin/settings/email").send({ ...body, pass: undefined }).expect(400); // password required first time
    const put = await owner.put("/api/admin/settings/email").send(body).expect(200);
    expect(put.body.settings).toMatchObject({ configured: true, source: "database", hasPassword: true, host: "smtp.gmail.com" });
    expect(JSON.stringify(put.body)).not.toContain(secret);
    expect(JSON.stringify((await owner.get("/api/admin/settings/email")).body)).not.toContain(secret);
    const { AppSetting } = await import("../src/models/index.js");
    expect(JSON.stringify(await AppSetting.findOne({ key: "authSmtp" }).lean())).not.toContain(secret); // encrypted at rest
    expect(JSON.stringify(await AuditLog.find({ action: "settings.email.update" }).lean())).not.toContain(secret);
    // Keeping the stored password when only other fields change.
    await owner.put("/api/admin/settings/email").send({ ...body, pass: undefined, port: 587, secure: false }).expect(200);

    const ok = (await owner.post("/api/admin/settings/email/test").send({})).body;
    expect(ok).toMatchObject({ ok: true });
    expect(ctx.smtpTest.calls.at(-1)).toMatchObject({ host: "smtp.gmail.com", to: OWNER });

    ctx.smtpTest.error = Object.assign(new Error(`535 5.7.8 Username and Password not accepted for ${OWNER} ${secret}`), { code: "EAUTH", responseCode: 535 });
    const bad = (await owner.post("/api/admin/settings/email/test").send({})).body;
    ctx.smtpTest.error = null;
    expect(bad).toMatchObject({ ok: false, code: "AUTH_FAILED" });
    expect(JSON.stringify(bad)).not.toContain(secret);
    expect(JSON.stringify(bad)).not.toContain("535");

    await owner.del("/api/admin/settings/email").expect(200);
    expect((await owner.get("/api/admin/settings/email")).body.settings.configured).toBe(false);
    expect((await owner.post("/api/admin/settings/email/test").send({})).status).toBe(409);
  });

  it("the OTP mailer picks up Admin-saved settings without a restart and reports 'not configured' otherwise", async () => {
    const owner = await otpUser(ctx, OWNER);
    const mailer = createConfiguredAuthMailer(ctx.config);
    expect(await mailer.isConfigured!()).toBe(false);
    await owner.put("/api/admin/settings/email").send({ host: "smtp.example.com", port: 465, secure: true, user: "u", from: "App <a@example.com>", pass: "p" }).expect(200);
    expect(await mailer.isConfigured!()).toBe(true);
    await owner.del("/api/admin/settings/email").expect(200);
    expect(await mailer.isConfigured!()).toBe(false);
    mailer.close();
    // With no provider, OTP requests fail with the generic 503 and nothing is stored or sent.
    const app = createApp({ config: ctx.config, mailerFactory: (undefined as any), runner: ctx.runner, googleClient: ctx.googleClient, authMailer: createConfiguredAuthMailer(ctx.config) });
    const r = await request(app).post("/api/auth/otp/request").send({ email: uniq("n") });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("OTP_UNAVAILABLE");
    expect((await request(app).get("/api/auth/providers")).body.otp).toBe(false);
  });
});

describe("sending quota", () => {
  it("rejects a job that would exceed the rolling 24-hour limit", async () => {
    const c = await newUser(ctx);
    await fillProfile(c); await verifiedSender(c);
    const t = await reviewedDefaultTemplate(c);
    const a = await addContact(c);
    const original = ctx.config.dailySendLimit;
    ctx.config.dailySendLimit = 0;
    const r = await c.post("/api/emails/send").send({ templateId: t.id, contactIds: [a.id], idempotencyKey: "quota-test-key-1", confirmation: true });
    ctx.config.dailySendLimit = original;
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("QUOTA_EXCEEDED");
  });
});
