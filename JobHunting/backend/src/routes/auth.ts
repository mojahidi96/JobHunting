import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { userDto } from "../lib/dto.js";
import { randomToken, safeEqual, sha256 } from "../lib/crypto.js";
import { isValidEmail, parse } from "../lib/validation.js";
import { OAUTH_COOKIE, currentUser, requireAuth, sessionUserId } from "../middleware/auth.js";
import { limiter } from "../middleware/rateLimit.js";
import { OAuthState, Session, User } from "../models/index.js";
import type { AuthMailer } from "../services/authMailer.js";
import { resolveVerifiedIdentity } from "../services/accountService.js";
import { clearSessionCookie, createStarterTemplates, hashPassword, startSession, verifyPassword } from "../services/authService.js";
import type { GoogleClient } from "../services/googleService.js";
import { ensureOwner } from "../services/ownerService.js";
import { requestOtp, verifyOtp } from "../services/otpService.js";
import { GMAIL_SEND_SCOPE } from "../services/googleService.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { EmailJob } from "../models/index.js";

const email = z.string().trim().toLowerCase().refine(isValidEmail, "must be a valid email address");
const password = z.string().min(10, "must be at least 10 characters").max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "must contain at least one letter and one number");
const registerSchema = z.object({ name: z.string().trim().min(1, "required").max(100), email, password }).strict();
const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
const otpRequestSchema = z.object({ email }).strict();
const otpVerifySchema = z.object({ email, code: z.string().trim().regex(/^\d{6}$/, "must be the 6-digit code") }).strict();
const passwordChangeSchema = z.object({ currentPassword: z.string().max(128).optional(), newPassword: password }).strict();

const b64url = (b: Buffer) => b.toString("base64url");

export interface AuthDeps { googleClient: GoogleClient | null; authMailer: AuthMailer | null }

export function authRoutes(config: Config, deps: AuthDeps) {
  const r = Router();
  const authLimit = limiter(config, 15 * 60_000, 20, "Too many attempts. Try again later.");
  const otpRequestLimit = limiter(config, 15 * 60_000, 10, "Too many code requests. Try again later.");
  const otpVerifyLimit = limiter(config, 15 * 60_000, 30, "Too many attempts. Try again later.");
  const auth = requireAuth(config);

  /** Which sign-in methods this deployment has configured (no secrets). */
  r.get("/providers", async (_req, res) => {
    res.json({ password: true, google: !!deps.googleClient, otp: !!deps.authMailer && (!deps.authMailer.isConfigured || await deps.authMailer.isConfigured()) });
  });

  /* --------------------------------------------------- email + password */
  r.post("/register", authLimit, async (req, res) => {
    const body = parse(registerSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    let user;
    try {
      user = await User.create({ name: body.name, email: body.email, passwordHash, emailVerified: false });
    } catch (e: any) {
      if (e?.code === 11000) throw new ApiError(409, "ACCOUNT_EXISTS", "An account with this email may already exist. Try signing in.");
      throw e;
    }
    await createStarterTemplates(user._id);
    const csrfToken = await startSession(config, res, user._id, "password");
    res.status(201).json({ user: userDto(user), csrfToken, isNewUser: true });
  });

  r.post("/login", authLimit, async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = await User.findOne({ email: body.email }).select("+passwordHash");
    const ok = await verifyPassword(user?.passwordHash ?? null, body.password);
    if (!user || !ok) throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
    const csrfToken = await startSession(config, res, user._id, "password");
    res.json({ user: userDto(user), csrfToken, isNewUser: false });
  });

  /* -------------------------------------------------------------- OTP */
  r.post("/otp/request", otpRequestLimit, async (req, res) => {
    const { email: to } = parse(otpRequestSchema, req.body);
    const out = await requestOtp(config, deps.authMailer, to);
    res.json({ ok: true, ...out }); // never contains the code
  });

  r.post("/otp/verify", otpVerifyLimit, async (req, res) => {
    const b = parse(otpVerifySchema, req.body);
    await verifyOtp(config, b.email, b.code);
    const { userId, isNew } = await resolveVerifiedIdentity({ email: b.email, name: "" });
    await ensureOwner(config, userId);
    const csrfToken = await startSession(config, res, userId, "otp");
    const user = await User.findById(userId);
    res.json({ user: userDto(user), csrfToken, isNewUser: isNew });
  });

  /* ----------------------------------------------------------- Google */
  const fail = (res: import("express").Response, code: string) => {
    res.clearCookie(OAUTH_COOKIE, { path: "/api/auth/google" });
    res.redirect(302, `${config.frontendUrl}/login?error=${code}`);
  };

  r.get("/google", async (_req, res) => {
    if (!deps.googleClient) return fail(res, "google_unavailable");
    const cookieToken = randomToken(32);
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = b64url(randomBytes(48));
    await OAuthState.create({ tokenHash: sha256(cookieToken), state, nonce, codeVerifier: verifier, expiresAt: new Date(Date.now() + 10 * 60_000) });
    res.cookie(OAUTH_COOKIE, cookieToken, { httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/api/auth/google", maxAge: 10 * 60_000 });
    res.redirect(302, deps.googleClient.authUrl({ state, nonce, codeChallenge: b64url(createHash("sha256").update(verifier).digest()) }));
  });

  r.get("/google/callback", async (req, res) => {
    if (!deps.googleClient) return fail(res, "google_unavailable");
    const q = req.query as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const cookieToken = str(req.cookies?.[OAUTH_COOKIE]);
    // One-time state: consumed on first use, so a replayed callback cannot sign in or create anything twice.
    const saved = cookieToken ? await OAuthState.findOneAndDelete({ tokenHash: sha256(cookieToken), expiresAt: { $gt: new Date() } }) : null;
    if (saved?.purpose === "gmail") return gmailCallback(req, res, saved, q);
    if (str(q.error)) return fail(res, str(q.error) === "access_denied" ? "google_denied" : "google_failed");
    if (!saved || !str(q.state) || !safeEqual(saved.state, str(q.state)) || !str(q.code)) return fail(res, "google_failed");
    try {
      const claims = await deps.googleClient.exchange(str(q.code), saved.codeVerifier);
      if (!claims.nonce || !safeEqual(claims.nonce, saved.nonce)) return fail(res, "google_failed");
      if (!claims.emailVerified) return fail(res, "google_unverified");
      const { userId } = await resolveVerifiedIdentity({ email: claims.email, name: claims.name, googleSub: claims.sub });
      await ensureOwner(config, userId);
      await startSession(config, res, userId, "google");
      res.clearCookie(OAUTH_COOKIE, { path: "/api/auth/google" });
      res.redirect(302, `${config.frontendUrl}/`);
    } catch (e) {
      console.error("Google sign-in failed:", e instanceof ApiError ? e.code : "exchange_error");
      fail(res, e instanceof ApiError && e.code === "GOOGLE_ACCOUNT_CONFLICT" ? "google_conflict" : e instanceof ApiError && e.code === "ACCOUNT_SUSPENDED" ? "account_suspended" : "google_failed");
    }
  });

  /**
   * Second half of "Connect Gmail" (started in routes/settings.ts). The state record is bound to the user who started it,
   * and the browser must still hold that user's session, so a link or cookie can't be replayed to attach someone else's mailbox.
   */
  async function gmailCallback(req: import("express").Request, res: import("express").Response, saved: { userId?: unknown; state: string; nonce: string; codeVerifier: string }, q: Record<string, unknown>) {
    const back = (code: string) => {
      res.clearCookie(OAUTH_COOKIE, { path: "/api/auth/google" });
      res.redirect(302, `${config.frontendUrl}/settings/email?gmail=${code}`);
    };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const uid = await sessionUserId(config, req);
    if (!uid || String(uid) !== String(saved.userId)) return back("failed");
    if (str(q.error)) return back(str(q.error) === "access_denied" ? "denied" : "failed");
    if (!deps.googleClient || !str(q.code) || !str(q.state) || !safeEqual(saved.state, str(q.state))) return back("failed");
    try {
      const grant = await deps.googleClient.exchangeGmail(str(q.code), saved.codeVerifier);
      if (!grant.nonce || !safeEqual(grant.nonce, saved.nonce)) return back("failed");
      if (!grant.emailVerified) return back("unverified");
      // Google's granular consent lets the user untick permissions: refuse unless sending was actually granted.
      if (!grant.scopes.includes(GMAIL_SEND_SCOPE)) return back("scope_missing");
      if (!grant.refreshToken) return back("no_refresh");
      if (await EmailJob.exists({ userId: uid, active: true })) return back("job_active");

      const user = await User.findById(uid).select("+emailIdentity.credential");
      if (!user) return back("failed");
      const old = user.emailIdentity;
      if (old?.provider === "gmail_oauth" && old.credential?.data) {
        try { await deps.googleClient.revoke(decryptSecret(old.credential as any, config.encryptionKey)); } catch { /* ignore */ }
      }
      await User.updateOne({ _id: uid }, { $set: {
        "emailIdentity.provider": "gmail_oauth",
        "emailIdentity.senderEmail": grant.email,
        "emailIdentity.senderName": old?.senderName || grant.name || user.name,
        "emailIdentity.credential": encryptSecret(grant.refreshToken, config.encryptionKey),
        // Authorised by the account owner through Google itself, so the sender is verified without sending anything.
        "emailIdentity.status": "verified", "emailIdentity.verifiedAt": new Date(), "emailIdentity.lastError": "",
      } });
      back("connected");
    } catch {
      console.error("Gmail connect failed");
      back("failed");
    }
  }

  /* --------------------------------------------------------- session */
  r.post("/logout", auth, async (req, res) => {
    await Session.deleteOne({ _id: req.auth!.sessionId });
    clearSessionCookie(config, res);
    res.json({ ok: true });
  });

  /** Restores the session after a page reload. Counts as activity (it is a user visit). */
  r.get("/me", auth, async (req, res) => {
    const user = await User.findById(req.auth!.userId).select("+passwordHash");
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
    res.json({
      user: userDto(user), csrfToken: req.auth!.csrfToken, hasPassword: !!user.passwordHash,
      session: {
        expiresAt: req.auth!.expiresAt.toISOString(),
        idleExpiresAt: new Date(req.auth!.lastActiveAt.getTime() + config.sessionIdleDays * 86_400_000).toISOString(),
      },
    });
  });

  /** Set or change the password. Revokes every session of the user and rotates the current one. */
  r.post("/password", auth, authLimit, async (req, res) => {
    const body = parse(passwordChangeSchema, req.body);
    const user = await User.findById(req.auth!.userId).select("+passwordHash");
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
    if (user.passwordHash) {
      if (!body.currentPassword || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
        throw new ApiError(403, "INVALID_CREDENTIALS", "Your current password is incorrect.");
      }
    }
    user.passwordHash = await hashPassword(body.newPassword);
    await user.save();
    await Session.deleteMany({ userId: user._id });
    const csrfToken = await startSession(config, res, user._id, "password", false);
    res.json({ ok: true, csrfToken });
  });

  return r;
}

export { currentUser };
