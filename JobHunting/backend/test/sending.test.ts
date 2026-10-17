import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addContact, fillProfile, newUser, reviewedDefaultTemplate, setup, verifiedSender, waitForJob, type Client, type TestCtx } from "./helpers.js";
import { User } from "../src/models/index.js";

let ctx: TestCtx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.teardown(); });
beforeEach(() => { ctx.mail.sent.length = 0; ctx.mail.failFor.clear(); ctx.mail.verifyError = null; ctx.mail.gate = null; ctx.mail.creds.length = 0; });

let n = 0;
const key = () => `idem-key-${++n}-${Math.random().toString(36).slice(2)}`;

async function readyUser() {
  const u = await newUser(ctx);
  await fillProfile(u);
  await verifiedSender(u, u.email);
  const tpl = await reviewedDefaultTemplate(u);
  return { u, tpl };
}
const send = (u: Client, body: Record<string, unknown>) => u.post("/api/emails/send").send({ confirmation: true, idempotencyKey: key(), ...body });

describe("templates", () => {
  it("gives new users one generic default template and a first-use prompt state", async () => {
    const u = await newUser(ctx);
    const r = await u.get("/api/email-templates").expect(200);
    expect(r.body.onboardingCompleted).toBe(false);
    expect(r.body.items.map((t: any) => t.starterKey)).toEqual(["generic"]);
    expect((await u.get("/api/email-templates/starters")).body.items.map((s: any) => s.key)).toContain("frontend-lead-example"); // still offered as an optional starter
    const def = r.body.items.find((t: any) => t.isDefault);
    expect(def.starterKey).toBe("generic");
    expect(def.reviewed).toBe(false);
    expect(def.html).not.toContain("Morgan Stanley"); // example is optional, not the default
  });

  it("supports CRUD, duplicate, rename, default, reset, and bumps the version on material edits", async () => {
    const u = await newUser(ctx);
    const created = (await u.post("/api/email-templates").send({ name: "Mine", subject: "Hi {{firstName}}", html: "<p>Hello {{Name}}</p>" }).expect(201)).body.item;
    expect(created.version).toBe(1);
    expect((await u.post("/api/email-templates").send({ name: "Mine", subject: "s", html: "h" })).status).toBe(409);
    const renamed = (await u.patch(`/api/email-templates/${created.id}`).send({ name: "Renamed" }).expect(200)).body.item;
    expect(renamed.version).toBe(1);
    const edited = (await u.patch(`/api/email-templates/${created.id}`).send({ html: "<p>Changed</p>" }).expect(200)).body.item;
    expect(edited.version).toBe(2);
    const dup = (await u.post(`/api/email-templates/${created.id}/duplicate`).expect(201)).body.item;
    expect(dup.name).toBe("Renamed (copy)");
    const def = (await u.patch(`/api/email-templates/${dup.id}`).send({ isDefault: true }).expect(200)).body.item;
    expect(def.isDefault).toBe(true);
    expect((await u.get("/api/email-templates")).body.items.filter((t: any) => t.isDefault)).toHaveLength(1);
    const starter = (await u.get("/api/email-templates")).body.items.find((t: any) => t.starterKey === "generic");
    await u.patch(`/api/email-templates/${starter.id}`).send({ html: "<p>x</p>" }).expect(200);
    const reset = (await u.post(`/api/email-templates/${starter.id}/reset`).expect(200)).body.item;
    expect(reset.html).toContain("{{SENDER_NAME}}");
    await u.del(`/api/email-templates/${dup.id}`).expect(200);
    expect((await u.get("/api/email-templates")).body.items.filter((t: any) => t.isDefault)).toHaveLength(1);
    expect((await u.patch(`/api/email-templates/${created.id}`).send({ placeholderConfig: { __proto__x: 1 } })).status).toBe(400);
  });

  it("review confirmation is per version and a material change requires review again", async () => {
    const u = await newUser(ctx);
    const t = await reviewedDefaultTemplate(u);
    const after = (await u.get(`/api/email-templates/${t.id}`)).body.item;
    expect(after.reviewed).toBe(true);
    expect((await u.get("/api/email-templates")).body.onboardingCompleted).toBe(true);
    const edited = (await u.patch(`/api/email-templates/${t.id}`).send({ subject: "New subject {{Role}}" }).expect(200)).body.item;
    expect(edited.reviewed).toBe(false);
    expect((await u.post(`/api/email-templates/${t.id}/review`).send({ confirmation: true, version: 1 })).status).toBe(409);
    expect((await u.post(`/api/email-templates/${t.id}/review`).send({ confirmation: false, version: 2 })).status).toBe(400);
  });
});

describe("placeholders and preview", () => {
  it("resolves contact, profile, manual, per-send and static values; escapes HTML; sanitises; never sends", async () => {
    const u = await newUser(ctx, "Pat Sender");
    await fillProfile(u);
    const c = await addContact(u, { Name: "Dana <b>Scott</b>", Company: "A&B", Role: "Dev", Link: "https://x.test/?a=1&b=2" });
    const template = {
      subject: "{{Role}} at {{Company}} / {{TARGET}}",
      html: '<p>Hi {{firstName}} {{Name}} {{Company}}</p><p>{{HEADLINE}} {{CONTACT_NO}} {{INTRO}} {{AVAIL}} {{TARGET}} {{LABEL}}</p><a href="{{Link}}">l</a><script>alert(1)</script><img src=x onerror=alert(1)>',
      placeholderConfig: {
        INTRO: { source: "manual", value: "My <i>intro</i>" },
        AVAIL: { source: "perSend", allowEmpty: false },
        TARGET: { source: "profile", field: "HEADLINE" },
        LABEL: { source: "static", value: "static text" },
      },
    };
    const res = await u.post("/api/emails/preview").send({ template, contactIds: [c.id], perSendValues: { AVAIL: "next month" } }).expect(200);
    const item = res.body.items[0];
    expect(item.subject).toBe("Dev at A&B / a Senior Engineer");
    expect(item.html).toContain("Hi Dana");
    expect(item.html).toContain("Dana &lt;b&gt;Scott&lt;/b&gt;"); // contact data escaped
    expect(item.html).toContain("A&amp;B");
    expect(item.html).toContain("My &lt;i&gt;intro&lt;/i&gt;");
    expect(item.html).toContain("next month");
    expect(item.html).toContain("static text");
    expect(item.html).toContain("+1 555 0100");
    expect(item.html).not.toMatch(/<script|onerror/i);
    expect(res.body.perSendFields).toEqual(["AVAIL"]);
    expect(ctx.mail.sent).toHaveLength(0);
  });

  it("flags unresolved and unknown placeholders and honours explicit empty fallbacks", async () => {
    const u = await newUser(ctx);
    const c = await addContact(u, { Link: undefined });
    const base = { subject: "S {{Role}}", html: "<p>{{Link}} {{AVAIL}} {{MYSTERY}}</p>" };
    const r1 = await u.post("/api/emails/preview").send({ template: { ...base, placeholderConfig: { AVAIL: { source: "perSend" } } }, contactIds: [c.id] }).expect(200);
    const details = r1.body.problems.find((p: any) => p.code === "PLACEHOLDERS_UNRESOLVED").details.join("|");
    expect(details).toMatch(/Link/);
    expect(details).toMatch(/AVAIL/);
    expect(details).toMatch(/MYSTERY/);
    expect(r1.body.items[0].html).toContain("{{MYSTERY}}");

    const r2 = await u.post("/api/emails/preview").send({
      template: { ...base, html: "<p>{{Link}} {{AVAIL}}</p>", placeholderConfig: { Link: { source: "contact", field: "Link", allowEmpty: true }, AVAIL: { source: "perSend", allowEmpty: true } } },
      contactIds: [c.id],
    }).expect(200);
    expect(r2.body.problems.find((p: any) => p.code === "PLACEHOLDERS_UNRESOLVED")).toBeUndefined();
  });
});

describe("sender identity", () => {
  it("never returns or logs credentials, encrypts at rest, resets verification on change, and tests without sending", async () => {
    const u = await newUser(ctx);
    const put = await u.put("/api/settings/email").send({ senderName: "S", senderEmail: "Send@Example.com", appPassword: "abcd efgh ijkl mnop" }).expect(200);
    expect(put.body.settings).toMatchObject({ senderEmail: "send@example.com", status: "unverified", hasCredential: true, loginEmail: u.email });
    expect(JSON.stringify(put.body)).not.toMatch(/abcdefghijklmnop|abcd efgh/);
    const doc = await User.findById(u.id).select("+emailIdentity.credential").lean();
    expect(JSON.stringify(doc!.emailIdentity)).not.toMatch(/abcdefghijklmnop/);
    expect(doc!.emailIdentity!.credential!.data).toBeTruthy();

    const bad = await u.put("/api/settings/email").send({ senderName: "S", senderEmail: "s@example.com", appPassword: "my normal password!" });
    expect(bad.status).toBe(400);
    const test = await u.post("/api/settings/email/test").expect(200);
    expect(test.body.settings.status).toBe("verified");
    expect(ctx.mail.sent).toHaveLength(0);
    expect(ctx.mail.creds.at(-1)!.password).toBe("abcdefghijklmnop"); // decrypted server-side only

    const changed = await u.put("/api/settings/email").send({ senderName: "S", senderEmail: "other@example.com" }).expect(200);
    expect(changed.body.settings.status).toBe("unverified");

    ctx.mail.verifyError = Object.assign(new Error("Invalid login: secret details"), { code: "EAUTH" });
    const failed = await u.post("/api/settings/email/test").expect(200);
    expect(failed.body.settings.status).toBe("failed");
    expect(JSON.stringify(failed.body)).not.toMatch(/secret details/);
  });
});

describe("sending workflow", () => {
  it("blocks until the sender is verified, the template reviewed, and confirmation is given", async () => {
    const u = await newUser(ctx);
    await fillProfile(u);
    const c = await addContact(u);
    const tpl = (await u.get("/api/email-templates")).body.items.find((t: any) => t.isDefault);
    const r1 = await send(u, { templateId: tpl.id, contactIds: [c.id] });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe("SENDER_NOT_VERIFIED");
    await verifiedSender(u, u.email);
    const r2 = await send(u, { templateId: tpl.id, contactIds: [c.id] });
    expect(r2.body.error.code).toBe("TEMPLATE_NOT_REVIEWED");
    await reviewedDefaultTemplate(u);
    const r3 = await u.post("/api/emails/send").send({ templateId: tpl.id, contactIds: [c.id], idempotencyKey: key() });
    expect(r3.body.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(ctx.mail.sent).toHaveLength(0);
  });

  it("ignores/rejects client-supplied from and recipient addresses", async () => {
    const { u, tpl } = await readyUser();
    const c = await addContact(u);
    for (const extra of [{ from: "boss@evil.test" }, { to: "victim@evil.test" }, { recipients: ["victim@evil.test"] }]) {
      const r = await send(u, { templateId: tpl.id, contactIds: [c.id], ...extra });
      expect(r.status).toBe(400);
    }
    expect((await send(u, { templateId: tpl.id, contactIds: ["victim@evil.test"] })).status).toBe(400);
    expect(ctx.mail.sent).toHaveLength(0);
    const ok = await send(u, { templateId: tpl.id, contactIds: [c.id] }).expect(202);
    await waitForJob(ctx, u, ok.body.job.jobId);
    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0].to).toBe(c.Email);
    expect(ctx.mail.sent[0].from).toBe(`Sender Name <${u.email}>`); // from the stored verified identity only
  });

  it("sends sequentially, persists per-recipient results, skips isSend=no and duplicates, and records failures", async () => {
    const { u, tpl } = await readyUser();
    const ok1 = await addContact(u);
    const ok2 = await addContact(u);
    const failing = await addContact(u);
    const skipNo = await addContact(u, { isSend: "no" });
    ctx.mail.failFor.set(failing.Email, Object.assign(new Error("550 rejected: mailbox xyz"), { responseCode: 550 }));

    const res = await send(u, { templateId: tpl.id, contactIds: [ok1.id, ok2.id, failing.id, skipNo.id, ok1.id] }).expect(202);
    const { job, recipients } = await waitForJob(ctx, u, res.body.job.jobId);
    expect(job.status).toBe("completed_with_errors");
    expect(job.totals).toEqual({ selected: 4, sent: 2, failed: 1, skipped: 1 });
    const by = Object.fromEntries(recipients.map((r: any) => [r.recipient.Email, r]));
    expect(by[ok1.Email].status).toBe("sent");
    expect(by[ok1.Email].providerMessageId).toMatch(/^<id-/);
    expect(by[failing.Email].status).toBe("failed");
    expect(by[failing.Email].error).toMatchObject({ code: "RECIPIENT_REJECTED", retryable: false });
    expect(JSON.stringify(by[failing.Email])).not.toMatch(/xyz/);
    expect(by[skipNo.Email].status).toBe("skipped");
    expect(ctx.mail.sent.map((m) => m.to)).toEqual([ok1.Email, ok2.Email]);
    expect(ctx.mail.sent[0].html).toContain("Sender Name");

    const list = (await u.get("/api/recruiters")).body.items;
    expect(list.find((c: any) => c.id === ok1.id).deliveryStatus).toBe("sent");
    expect(list.find((c: any) => c.id === failing.id).deliveryStatus).toBe("failed");
    expect(list.find((c: any) => c.id === skipNo.id).deliveryStatus).toBe("skipped");

    const hist = (await u.get("/api/emails/history").expect(200)).body;
    expect(hist.counts).toEqual({ attempted: 3, sent: 2, failed: 1, skipped: 1 });
    expect((await u.get(`/api/emails/history?status=failed`)).body.total).toBe(1);
    expect((await u.get(`/api/emails/history?q=${ok2.Email.slice(0, 4)}`)).body.total).toBeGreaterThan(0);
    expect((await u.get(`/api/emails/history/${recipients[0].id}`).expect(200)).body.item.jobId).toBe(job.jobId);
    expect(JSON.stringify(hist)).not.toMatch(/html|password|credential/i);
  });

  it("is idempotent and prevents overlapping jobs", async () => {
    const { u, tpl } = await readyUser();
    const a = await addContact(u);
    const b = await addContact(u);
    let release!: () => void;
    ctx.mail.gate = new Promise<void>((r) => { release = r; });
    const k = key();
    const first = await u.post("/api/emails/send").send({ confirmation: true, idempotencyKey: k, templateId: tpl.id, contactIds: [a.id] }).expect(202);
    const replay = await u.post("/api/emails/send").send({ confirmation: true, idempotencyKey: k, templateId: tpl.id, contactIds: [a.id] }).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.job.jobId).toBe(first.body.job.jobId);

    const overlap = await send(u, { templateId: tpl.id, contactIds: [b.id] });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe("JOB_ACTIVE");

    const mid = (await u.get(`/api/emails/jobs/${first.body.job.jobId}`)).body.job;
    expect(["queued", "running"]).toContain(mid.status);
    release();
    const done = await waitForJob(ctx, u, first.body.job.jobId);
    expect(done.job.status).toBe("completed");
    expect(ctx.mail.sent).toHaveLength(1); // replay + overlap sent nothing extra
    await send(u, { templateId: tpl.id, contactIds: [b.id] }).expect(202); // allowed again after completion
    await ctx.runner.idle();
  });

  it("blocks sending on unresolved placeholders and accepts per-send values", async () => {
    const { u } = await readyUser();
    const c = await addContact(u);
    const t = (await u.post("/api/email-templates").send({
      name: "Per send", subject: "Hi {{firstName}}", html: "<p>Available {{AVAIL}}</p>", placeholderConfig: { AVAIL: { source: "perSend" } },
    }).expect(201)).body.item;
    await u.post(`/api/email-templates/${t.id}/review`).send({ confirmation: true, version: t.version }).expect(200);
    const blocked = await send(u, { templateId: t.id, contactIds: [c.id] });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("PLACEHOLDERS_UNRESOLVED");
    expect(ctx.mail.sent).toHaveLength(0);
    const ok = await send(u, { templateId: t.id, contactIds: [c.id], perSendValues: { AVAIL: "immediately" } }).expect(202);
    await waitForJob(ctx, u, ok.body.job.jobId);
    expect(ctx.mail.sent[0].html).toContain("immediately");
  });

  it("retries only definite, retryable failures as a new auditable job and never uncertain ones", async () => {
    const { u, tpl } = await readyUser();
    const temp = await addContact(u);
    const unknown = await addContact(u);
    ctx.mail.failFor.set(temp.Email, Object.assign(new Error("421 try later"), { responseCode: 421 }));
    ctx.mail.failFor.set(unknown.Email, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    const first = await send(u, { templateId: tpl.id, contactIds: [temp.id, unknown.id] }).expect(202);
    const { recipients } = await waitForJob(ctx, u, first.body.job.jobId);
    expect(recipients.find((r: any) => r.recipient.Email === temp.Email).error.retryable).toBe(true);
    expect(recipients.find((r: any) => r.recipient.Email === unknown.Email).error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });

    expect((await u.post(`/api/emails/jobs/${first.body.job.jobId}/retry`).send({ idempotencyKey: key() })).body.error.code).toBe("CONFIRMATION_REQUIRED");
    ctx.mail.failFor.clear();
    const retry = await u.post(`/api/emails/jobs/${first.body.job.jobId}/retry`).send({ confirmation: true, idempotencyKey: key() }).expect(202);
    expect(retry.body.job.retryOf).toBe(first.body.job.jobId);
    const done = await waitForJob(ctx, u, retry.body.job.jobId);
    expect(done.recipients).toHaveLength(1);
    expect(done.recipients[0].recipient.Email).toBe(temp.Email);
    expect(done.recipients[0].status).toBe("sent");
    expect(ctx.mail.sent.map((m) => m.to)).toEqual([temp.Email]); // the uncertain one was not resent
    const again = await u.post(`/api/emails/jobs/${first.body.job.jobId}/retry`).send({ confirmation: true, idempotencyKey: key() });
    expect(again.status).toBe(422); // already retried
  });

  it("does not send on login, import or page-load style reads", async () => {
    const u = await newUser(ctx);
    await u.get("/api/recruiters"); await u.get("/api/auth/me"); await u.get("/api/emails/history");
    await u.agent.post("/api/auth/login").send({ email: u.email, password: "correct horse battery 1" });
    expect(ctx.mail.sent).toHaveLength(0);
  });
});

describe("cross-user isolation", () => {
  it("denies user B access to user A's resources by id", async () => {
    const { u: a, tpl } = await readyUser();
    const b = await newUser(ctx);
    await fillProfile(b); await verifiedSender(b, b.email);
    const contact = await addContact(a);
    const sendRes = await send(a, { templateId: tpl.id, contactIds: [contact.id] }).expect(202);
    const { recipients } = await waitForJob(ctx, a, sendRes.body.job.jobId);
    const buf = Buffer.from(JSON.stringify([{ Name: "I", Company: "C", Email: "imp@c.test", Role: "R" }]));
    const imp = (await a.post("/api/imports").attach("file", buf, "a.json").expect(201)).body.import;
    ctx.mail.sent.length = 0;

    expect((await b.patch(`/api/recruiters/${contact.id}`).send({ Role: "Hacked" })).status).toBe(404);
    expect((await b.del(`/api/recruiters/${contact.id}`)).status).toBe(404);
    expect((await b.get(`/api/email-templates/${tpl.id}`)).status).toBe(404);
    expect((await b.patch(`/api/email-templates/${tpl.id}`).send({ name: "x" })).status).toBe(404);
    expect((await b.del(`/api/email-templates/${tpl.id}`)).status).toBe(404);
    expect((await b.post(`/api/email-templates/${tpl.id}/review`).send({ confirmation: true, version: 1 })).status).toBe(404);
    expect((await b.get(`/api/emails/jobs/${sendRes.body.job.jobId}`)).status).toBe(404);
    expect((await b.get(`/api/emails/history/${recipients[0].id}`)).status).toBe(404);
    expect((await b.post(`/api/emails/jobs/${sendRes.body.job.jobId}/retry`).send({ confirmation: true, idempotencyKey: key() })).status).toBe(404);
    expect((await b.del(`/api/imports/${imp.id}`)).status).toBe(404);

    // using A's contact / template ids inside B's own requests
    const bTpl = (await b.get("/api/email-templates")).body.items[0];
    expect((await send(b, { templateId: bTpl.id, contactIds: [contact.id] })).status).toBe(404);
    expect((await send(b, { templateId: tpl.id, contactIds: [(await addContact(b)).id] })).status).toBe(404);
    expect((await b.post("/api/emails/preview").send({ templateId: tpl.id, contactIds: [contact.id] })).status).toBe(404);

    // lists only show own data; client-supplied userId is not honoured
    expect((await b.get("/api/recruiters")).body.items.every((c: any) => c.id !== contact.id)).toBe(true);
    expect((await b.get("/api/emails/history")).body.total).toBe(0);
    expect((await b.get("/api/imports")).body.items).toHaveLength(0);
    expect((await b.get(`/api/emails/history?jobId=${sendRes.body.job.jobId}`)).body.total).toBe(0);
    const spoof = await b.post("/api/recruiters").send({ Name: "S", Company: "C", Email: "spoof@c.test", Role: "R", userId: a.id });
    expect(spoof.status).toBe(400);
    const profile = (await b.get("/api/profile")).body.profile;
    expect(profile.loginEmail).toBe(b.email);
    expect(ctx.mail.sent).toHaveLength(0);
    expect((await a.get(`/api/recruiters`)).body.items.find((c: any) => c.id === contact.id).Role).not.toBe("Hacked");
  });
});

describe("account lifecycle", () => {
  it("exports the owner's data and deletes everything on request", async () => {
    const { u, tpl } = await readyUser();
    const c = await addContact(u);
    const s = await send(u, { templateId: tpl.id, contactIds: [c.id] }).expect(202);
    await waitForJob(ctx, u, s.body.job.jobId);
    const exp = (await u.get("/api/account/export").expect(200)).body;
    expect(exp.contacts).toHaveLength(1);
    expect(JSON.stringify(exp)).not.toMatch(/passwordHash|credential|tokenHash/);
    expect((await u.del("/api/account").send({ password: "wrong", confirm: true })).status).toBe(403);
    await u.del("/api/account").send({ password: "correct horse battery 1", confirm: true }).expect(200);
    expect((await u.get("/api/auth/me")).status).toBe(401);
    expect(await User.countDocuments({ email: u.email })).toBe(0);
  });
});
