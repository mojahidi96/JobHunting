import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { newUser, setup, type TestCtx } from "./helpers.js";
import { EmailTemplate, OtpCode, Session, User } from "../src/models/index.js";

let ctx: TestCtx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.teardown(); });
beforeEach(() => { ctx.authMail.sent.length = 0; ctx.authMail.fail = false; ctx.google.next = null; ctx.google.failExchange = false; });

// Mongoose timestamps make createdAt immutable, so backdate through the raw collection.
const backdate = (email: string, ms: number) => OtpCode.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - ms) } });
const lastCode = (to: string) => ctx.authMail.sent.filter((m) => m.to === to).at(-1)!.code;

async function googleLogin(agent: ReturnType<typeof request.agent>, claims: Partial<NonNullable<typeof ctx.google.next>> & { email: string; sub: string }) {
  ctx.google.next = { name: "G User", emailVerified: true, ...claims } as NonNullable<typeof ctx.google.next>;
  const start = await agent.get("/api/auth/google");
  expect(start.status).toBe(302);
  const cb = await agent.get(`/api/auth/google/callback?code=abc&state=${ctx.google.lastAuth!.state}`);
  return { start, cb };
}

describe("providers", () => {
  it("reports which sign-in methods are configured", async () => {
    const r = await request(ctx.app).get("/api/auth/providers").expect(200);
    expect(r.body).toEqual({ password: true, google: true, otp: true });
  });
});

describe("password registration rules", () => {
  it("requires only name/email/password with a strong-enough password, and rejects extra fields", async () => {
    const base = { name: "P", email: "pw-rules@example.com" };
    expect((await request(ctx.app).post("/api/auth/register").send({ ...base, password: "allletterspassword" })).status).toBe(400);
    expect((await request(ctx.app).post("/api/auth/register").send({ ...base, password: "short1" })).status).toBe(400);
    expect((await request(ctx.app).post("/api/auth/register").send({ ...base, password: "goodpassword123", phone: "1" })).status).toBe(400);
    const ok = await request(ctx.app).post("/api/auth/register").send({ ...base, password: "goodpassword123" }).expect(201);
    expect(ok.body.user.onboardingCompleted).toBe(false);
    expect(ok.body.user.emailVerified).toBe(false);
  });
});

describe("email OTP", () => {
  it("logs in an existing user and registers a new one, never exposing the code", async () => {
    const existing = await newUser(ctx, "Existing", "otp-existing@example.com");
    const agent = request.agent(ctx.app);
    const req = await agent.post("/api/auth/otp/request").send({ email: "OTP-Existing@example.com" }).expect(200);
    expect(JSON.stringify(req.body)).not.toMatch(/\d{6}/);
    expect(ctx.authMail.sent).toHaveLength(1);
    const code = lastCode("otp-existing@example.com");
    expect(code).toMatch(/^\d{6}$/);
    const stored = await OtpCode.findOne({ email: "otp-existing@example.com" }).lean();
    expect(JSON.stringify(stored)).not.toContain(code); // only a hash is stored
    const v = await agent.post("/api/auth/otp/verify").send({ email: "otp-existing@example.com", code }).expect(200);
    expect(v.body.user.id).toBe(existing.id); // same user id, no duplicate
    expect(v.body.isNewUser).toBe(false);
    expect(JSON.stringify(v.body)).not.toContain(code);
    expect((await agent.get("/api/auth/me")).status).toBe(200);

    const fresh = request.agent(ctx.app);
    await fresh.post("/api/auth/otp/request").send({ email: "otp-new@example.com" }).expect(200);
    const nv = await fresh.post("/api/auth/otp/verify").send({ email: "otp-new@example.com", code: lastCode("otp-new@example.com") }).expect(200);
    expect(nv.body.isNewUser).toBe(true);
    expect(nv.body.user).toMatchObject({ emailVerified: true, onboardingCompleted: false });
    expect(await User.countDocuments({ email: "otp-new@example.com" })).toBe(1);
    expect(await EmailTemplate.countDocuments({ userId: nv.body.user.id })).toBe(1); // default template created once
  });

  it("is single use, expires, and a resend invalidates the previous code", async () => {
    const email = "otp-rules@example.com";
    await request(ctx.app).post("/api/auth/otp/request").send({ email }).expect(200);
    const first = lastCode(email);
    await backdate(email, 120_000); // skip cooldown
    await request(ctx.app).post("/api/auth/otp/request").send({ email }).expect(200);
    const second = lastCode(email);
    expect((await request(ctx.app).post("/api/auth/otp/verify").send({ email, code: first })).body.error.code).toBe("OTP_INVALID");
    await request(ctx.app).post("/api/auth/otp/verify").send({ email, code: second }).expect(200);
    const replay = await request(ctx.app).post("/api/auth/otp/verify").send({ email, code: second });
    expect(replay.status).toBe(400); // single use

    const e2 = "otp-expire@example.com";
    await request(ctx.app).post("/api/auth/otp/request").send({ email: e2 }).expect(200);
    await OtpCode.updateMany({ email: e2 }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const exp = await request(ctx.app).post("/api/auth/otp/verify").send({ email: e2, code: lastCode(e2) });
    expect(exp.body.error.code).toBe("OTP_EXPIRED");
  });

  it("enforces resend cooldown, hourly limit and attempt limit", async () => {
    const email = "otp-limits@example.com";
    await request(ctx.app).post("/api/auth/otp/request").send({ email }).expect(200);
    const cd = await request(ctx.app).post("/api/auth/otp/request").send({ email });
    expect(cd.status).toBe(429);
    expect(cd.body.error.code).toBe("OTP_COOLDOWN");
    expect(cd.body.error.meta.retryAfterSeconds).toBeGreaterThan(0);

    const real = lastCode(email);
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await request(ctx.app).post("/api/auth/otp/verify").send({ email, code: wrong });
      expect(r.body.error.code).toBe("OTP_INVALID");
      expect(r.body.error.meta.attemptsRemaining).toBe(4 - i);
    }
    const locked = await request(ctx.app).post("/api/auth/otp/verify").send({ email, code: wrong });
    expect(locked.body.error.code).toBe("OTP_LOCKED");
    expect((await request(ctx.app).post("/api/auth/otp/verify").send({ email, code: real })).status).toBe(400); // locked even for the right code

    const e2 = "otp-hourly@example.com";
    for (let i = 0; i < 5; i++) {
      await backdate(e2, 120_000 - i);
      await request(ctx.app).post("/api/auth/otp/request").send({ email: e2 }).expect(200);
    }
    await backdate(e2, 120_000);
    expect((await request(ctx.app).post("/api/auth/otp/request").send({ email: e2 })).body.error.code).toBe("OTP_RATE_LIMITED");
  });

  it("answers the same for unknown and known addresses, and handles mail failure", async () => {
    const a = await request(ctx.app).post("/api/auth/otp/request").send({ email: "nobody-here@example.com" });
    await newUser(ctx, "Known", "known-otp@example.com");
    const b = await request(ctx.app).post("/api/auth/otp/request").send({ email: "known-otp@example.com" });
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body)).toEqual(Object.keys(b.body));
    ctx.authMail.fail = true;
    const f = await request(ctx.app).post("/api/auth/otp/request").send({ email: "mail-fail@example.com" });
    expect(f.status).toBe(502);
    expect(await OtpCode.countDocuments({ email: "mail-fail@example.com" })).toBe(0);
    expect((await request(ctx.app).post("/api/auth/otp/verify").send({ email: "x@example.com", code: "12ab56" })).status).toBe(400);
  });
});

describe("Google sign-in", () => {
  it("creates a user on first sign-in and reuses it on repeat (no duplicates)", async () => {
    const agent = request.agent(ctx.app);
    const { start, cb } = await googleLogin(agent, { email: "g-new@example.com", sub: "sub-1", name: "Gina Google" });
    expect(String(start.headers["set-cookie"])).toMatch(/jh_oauth=.*HttpOnly/i);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe("http://localhost:5173/");
    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.user).toMatchObject({ email: "g-new@example.com", name: "Gina Google", emailVerified: true, googleLinked: true, onboardingCompleted: false });
    expect(me.body.hasPassword).toBe(false);

    const again = request.agent(ctx.app);
    await googleLogin(again, { email: "g-new@example.com", sub: "sub-1" });
    expect(await User.countDocuments({ email: "g-new@example.com" })).toBe(1);
    expect((await again.get("/api/auth/me")).body.user.id).toBe(me.body.user.id);
  });

  it("rejects replayed callbacks, state mismatch, provider errors, cancellation and unverified emails", async () => {
    const agent = request.agent(ctx.app);
    const { cb } = await googleLogin(agent, { email: "g-replay@example.com", sub: "sub-r" });
    expect(cb.status).toBe(302);
    const replay = await agent.get(`/api/auth/google/callback?code=abc&state=${ctx.google.lastAuth!.state}`);
    expect(replay.headers.location).toContain("/login?error=google_failed");

    const a2 = request.agent(ctx.app);
    ctx.google.next = { sub: "s2", email: "g-state@example.com", emailVerified: true, name: "x" };
    await a2.get("/api/auth/google");
    expect((await a2.get("/api/auth/google/callback?code=abc&state=wrong")).headers.location).toContain("google_failed");
    expect(await User.countDocuments({ email: "g-state@example.com" })).toBe(0);

    const a3 = request.agent(ctx.app);
    await a3.get("/api/auth/google");
    expect((await a3.get("/api/auth/google/callback?error=access_denied")).headers.location).toContain("google_denied");
    expect((await request(ctx.app).get("/api/auth/google/callback?code=a&state=b")).headers.location).toContain("google_failed"); // no state cookie

    const a4 = request.agent(ctx.app);
    const un = await googleLogin(a4, { email: "g-unverified@example.com", sub: "s4", emailVerified: false });
    expect(un.cb.headers.location).toContain("google_unverified");
    expect(await User.countDocuments({ email: "g-unverified@example.com" })).toBe(0);
    expect((await a4.get("/api/auth/me")).status).toBe(401);

    const a5 = request.agent(ctx.app);
    ctx.google.failExchange = true;
    await a5.get("/api/auth/google");
    expect((await a5.get(`/api/auth/google/callback?code=abc&state=${ctx.google.lastAuth!.state}`)).headers.location).toContain("google_failed");

    const a6 = request.agent(ctx.app);
    const nonceBad = await googleLogin(a6, { email: "g-nonce@example.com", sub: "s6", nonce: "attacker-nonce" });
    expect(nonceBad.cb.headers.location).toContain("google_failed");
  });

  it("links to an existing verified account but never to an unverified password account's credentials", async () => {
    // An attacker pre-registers the victim's address with their own password (email never verified).
    const attacker = await newUser(ctx, "Attacker", "victim-g@example.com");
    const victim = request.agent(ctx.app);
    await googleLogin(victim, { email: "victim-g@example.com", sub: "victim-sub" });
    const me = await victim.get("/api/auth/me").expect(200);
    expect(me.body.user.id).toBe(attacker.id); // same account (linked), contacts etc. stay with this user id
    expect(me.body.user).toMatchObject({ emailVerified: true, googleLinked: true });
    // The attacker's pre-set password no longer works.
    const login = await request(ctx.app).post("/api/auth/login").send({ email: "victim-g@example.com", password: "correct horse battery 1" });
    expect(login.status).toBe(401);

    // Verified password-less account linked to a different Google subject is refused.
    const other = request.agent(ctx.app);
    const conflict = await googleLogin(other, { email: "victim-g@example.com", sub: "another-sub" });
    expect(conflict.cb.headers.location).toContain("google_conflict");
  });

  it("OTP sign-in to an unverified password account removes the unproven password", async () => {
    await newUser(ctx, "Squatted", "squat@example.com");
    await request(ctx.app).post("/api/auth/otp/request").send({ email: "squat@example.com" }).expect(200);
    await request(ctx.app).post("/api/auth/otp/verify").send({ email: "squat@example.com", code: lastCode("squat@example.com") }).expect(200);
    expect((await request(ctx.app).post("/api/auth/login").send({ email: "squat@example.com", password: "correct horse battery 1" })).status).toBe(401);
  });

  it("concurrent first-time sign-ins create exactly one user", async () => {
    ctx.google.next = { sub: "race-sub", email: "race@example.com", emailVerified: true, name: "Race" };
    const agents = [request.agent(ctx.app), request.agent(ctx.app), request.agent(ctx.app)];
    const states: string[] = [];
    for (const a of agents) { await a.get("/api/auth/google"); states.push(ctx.google.lastAuth!.state); }
    await Promise.all(agents.map((a, i) => a.get(`/api/auth/google/callback?code=c&state=${states[i]}`)));
    expect(await User.countDocuments({ email: "race@example.com" })).toBe(1);
    expect(await EmailTemplate.countDocuments({ userId: (await User.findOne({ email: "race@example.com" }))!._id })).toBe(1);
  });
});

describe("sessions", () => {
  it("restores a session after reload and reports the policy", async () => {
    const u = await newUser(ctx);
    const me = await u.get("/api/auth/me").expect(200);
    expect(new Date(me.body.session.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(me.body.hasPassword).toBe(true);
  });

  it("expires after 7 days of inactivity (server-side) with SESSION_EXPIRED", async () => {
    const u = await newUser(ctx);
    await Session.updateMany({ userId: u.id }, { $set: { lastActiveAt: new Date(Date.now() - 7 * 86_400_000 - 1000) } });
    const r = await u.get("/api/recruiters");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("SESSION_EXPIRED");
    expect(await Session.countDocuments({ userId: u.id })).toBe(0);
    expect((await u.get("/api/auth/me")).status).toBe(401);
  });

  it("stays valid just under 7 days idle and slides on real activity", async () => {
    const u = await newUser(ctx);
    await Session.updateMany({ userId: u.id }, { $set: { lastActiveAt: new Date(Date.now() - 6 * 86_400_000) } });
    await u.get("/api/recruiters").expect(200);
    const s = await Session.findOne({ userId: u.id }).lean();
    expect(Date.now() - s!.lastActiveAt.getTime()).toBeLessThan(10_000);
  });

  it("enforces the absolute maximum lifetime even when active", async () => {
    const u = await newUser(ctx);
    await Session.updateMany({ userId: u.id }, { $set: { expiresAt: new Date(Date.now() - 1000), lastActiveAt: new Date() } });
    const r = await u.get("/api/recruiters");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("does not extend the session on background polling", async () => {
    const u = await newUser(ctx);
    const old = new Date(Date.now() - 3 * 86_400_000);
    await Session.updateMany({ userId: u.id }, { $set: { lastActiveAt: old } });
    await u.agent.get("/api/emails/jobs").set("X-Background", "1").expect(200);
    expect((await Session.findOne({ userId: u.id }).lean())!.lastActiveAt.getTime()).toBe(old.getTime());
    await u.get("/api/emails/jobs").expect(200); // a normal request counts as activity
    expect((await Session.findOne({ userId: u.id }).lean())!.lastActiveAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("logout invalidates the session immediately, including a stolen cookie", async () => {
    const u = await newUser(ctx);
    const raw = await Session.findOne({ userId: u.id }).lean();
    await u.post("/api/auth/logout").expect(200);
    expect(await Session.countDocuments({ _id: raw!._id })).toBe(0);
    expect((await u.get("/api/auth/me")).status).toBe(401);
  });

  it("changing the password revokes every other session and rotates the current one", async () => {
    const u = await newUser(ctx, "Pw", "pw-change@example.com");
    const other = request.agent(ctx.app);
    await other.post("/api/auth/login").send({ email: "pw-change@example.com", password: "correct horse battery 1" }).expect(200);
    expect((await other.get("/api/auth/me")).status).toBe(200);
    expect((await u.post("/api/auth/password").send({ currentPassword: "wrong", newPassword: "brand-new-pass-9" })).status).toBe(403);
    const r = await u.post("/api/auth/password").send({ currentPassword: "correct horse battery 1", newPassword: "brand-new-pass-9" }).expect(200);
    expect(r.body.csrfToken).toBeTruthy();
    expect((await other.get("/api/auth/me")).status).toBe(401);
    expect(await Session.countDocuments({ userId: u.id })).toBe(1);
    const me = await u.get("/api/auth/me").expect(200); // current browser continues with the rotated cookie
    expect(me.body.csrfToken).toBe(r.body.csrfToken);
    expect((await request(ctx.app).post("/api/auth/login").send({ email: "pw-change@example.com", password: "brand-new-pass-9" })).status).toBe(200);
  });

  it("an OTP/Google-only user can set a first password without a current one", async () => {
    const agent = request.agent(ctx.app);
    await agent.post("/api/auth/otp/request").send({ email: "setpw@example.com" });
    const v = await agent.post("/api/auth/otp/verify").send({ email: "setpw@example.com", code: lastCode("setpw@example.com") }).expect(200);
    const r = await agent.post("/api/auth/password").set("X-CSRF-Token", v.body.csrfToken).send({ newPassword: "first-password-1" }).expect(200);
    expect(r.body.ok).toBe(true);
  });
});

describe("onboarding and theme", () => {
  it("needs only a name, persists optional fields, and keeps data on the same user id", async () => {
    const u = await newUser(ctx, "Orig", "onboard@example.com");
    expect((await u.post("/api/onboarding/complete").send({ name: "" })).status).toBe(400);
    expect((await u.post("/api/onboarding/complete").send({ name: "X", phone: "1" })).status).toBe(400);
    const done = await u.post("/api/onboarding/complete").send({ name: "Olivia On", headline: "Frontend Lead", experienceYears: 9 }).expect(200);
    expect(done.body.user).toMatchObject({ name: "Olivia On", onboardingCompleted: true, id: u.id });
    const stored = await User.findById(u.id).lean();
    expect(stored!.profile!.headline).toBe("Frontend Lead");
    expect(stored!.profile!.experienceYears).toBe(9);
    expect(stored!.profile!.phone).toBe(""); // optional details are not required
    const skip = await newUser(ctx);
    const s = await skip.post("/api/onboarding/complete").send({ name: "Skipper" }).expect(200);
    expect(s.body.user.onboardingCompleted).toBe(true);
    expect((await u.get("/api/auth/me")).body.user.onboardingCompleted).toBe(true);
  });

  it("stores the theme preference on the profile", async () => {
    const u = await newUser(ctx);
    expect((await u.get("/api/auth/me")).body.user.theme).toBe("system");
    await u.patch("/api/profile").send({ theme: "dark" }).expect(200);
    expect((await u.get("/api/auth/me")).body.user.theme).toBe("dark");
    expect((await u.patch("/api/profile").send({ theme: "purple" })).status).toBe(400);
  });

  it("OTP/Google-only accounts delete by typing their email", async () => {
    const agent = request.agent(ctx.app);
    await agent.post("/api/auth/otp/request").send({ email: "del-otp@example.com" });
    const v = await agent.post("/api/auth/otp/verify").send({ email: "del-otp@example.com", code: lastCode("del-otp@example.com") }).expect(200);
    const h = (r: request.Test) => r.set("X-CSRF-Token", v.body.csrfToken);
    expect((await h(agent.delete("/api/account")).send({ confirm: true, confirmEmail: "nope@example.com" })).status).toBe(403);
    await h(agent.delete("/api/account")).send({ confirm: true, confirmEmail: "del-otp@example.com" }).expect(200);
    expect(await User.countDocuments({ email: "del-otp@example.com" })).toBe(0);
  });
});
