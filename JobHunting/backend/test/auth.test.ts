import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { newUser, setup, type TestCtx } from "./helpers.js";
import { User } from "../src/models/index.js";

let ctx: TestCtx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.teardown(); });

describe("authentication", () => {
  it("registers, reads the session, logs out", async () => {
    const agent = request.agent(ctx.app);
    const reg = await agent.post("/api/auth/register").send({ name: "Ann", email: "Ann@Example.com", password: "a-long-password-1" });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe("ann@example.com");
    expect(JSON.stringify(reg.body)).not.toMatch(/passwordHash|credential/);
    const cookie = String(reg.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe("Ann");

    expect((await agent.post("/api/auth/logout")).status).toBe(403); // CSRF header missing
    expect((await agent.post("/api/auth/logout").set("X-CSRF-Token", me.body.csrfToken)).status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("hashes passwords with argon2id", async () => {
    await newUser(ctx, "Hash", "hash@example.com");
    const u = await User.findOne({ email: "hash@example.com" }).select("+passwordHash").lean();
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(u!.passwordHash).not.toContain("correct horse");
  });

  it("handles duplicate registration and bad credentials safely", async () => {
    await newUser(ctx, "Dup", "dup@example.com");
    const again = await request(ctx.app).post("/api/auth/register").send({ name: "Dup2", email: "DUP@example.com", password: "another-long-pass1" });
    expect(again.status).toBe(409);
    expect(await User.countDocuments({ email: "dup@example.com" })).toBe(1);

    const bad = await request(ctx.app).post("/api/auth/login").send({ email: "dup@example.com", password: "wrong-password" });
    const unknown = await request(ctx.app).post("/api/auth/login").send({ email: "nobody@example.com", password: "wrong-password" });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it("logs in with a correct password and validates input", async () => {
    await newUser(ctx, "Login", "login@example.com");
    const ok = await request(ctx.app).post("/api/auth/login").send({ email: "LOGIN@example.com", password: "correct horse battery 1" });
    expect(ok.status).toBe(200);
    const weak = await request(ctx.app).post("/api/auth/register").send({ name: "X", email: "x@example.com", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unauthenticated access to protected routes and CSRF-less mutations", async () => {
    for (const url of ["/api/recruiters", "/api/profile", "/api/email-templates", "/api/emails/history", "/api/settings/email", "/api/imports"]) {
      expect((await request(ctx.app).get(url)).status).toBe(401);
    }
    const u = await newUser(ctx);
    const noCsrf = await u.agent.post("/api/recruiters").send({ Name: "A", Company: "B", Email: "a@b.co", Role: "R" });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("CSRF_INVALID");
    const badOrigin = await u.post("/api/recruiters").set("Origin", "https://evil.example").send({ Name: "A", Company: "B", Email: "a@b.co", Role: "R" });
    expect(badOrigin.status).toBe(403);
  });

  it("creates the expected indexes", async () => {
    const idx = await mongoose.connection.collection("emailjobs").indexes();
    expect(idx.some((i) => i.partialFilterExpression?.active === true && i.unique)).toBe(true);
    const uidx = await mongoose.connection.collection("users").indexes();
    expect(uidx.some((i) => i.key.email === 1 && i.unique)).toBe(true);
  });
});
