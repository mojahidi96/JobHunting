import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { senderDto } from "../lib/dto.js";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../lib/crypto.js";
import { isValidEmail, parse } from "../lib/validation.js";
import { OAUTH_COOKIE, currentUser, requireAuth } from "../middleware/auth.js";
import type { Types } from "mongoose";
import { limiter } from "../middleware/rateLimit.js";
import { EmailJob, OAuthState, User } from "../models/index.js";
import type { GoogleClient } from "../services/googleService.js";
import { safeSendError, type MailerFactory } from "../services/mailService.js";

const putSchema = z.object({
  senderName: z.string().trim().min(1).max(100),
  senderEmail: z.string().trim().toLowerCase().refine(isValidEmail, "must be a valid email address"),
  // Gmail App Password only (16 chars, shown by Google with spaces). Omit to keep the stored one.
  appPassword: z.string().trim().max(64).optional(),
}).strict();
const patchSchema = z.object({ senderName: z.string().trim().min(1).max(100) }).strict();

export function settingsRoutes(config: Config, mailerFactory: MailerFactory, deps: { googleClient: GoogleClient | null }) {
  const r = Router();
  r.use(requireAuth(config));
  const flags = () => ({ gmailOAuthAvailable: !!deps.googleClient, appPasswordAllowed: config.allowAppPassword });

  const hasCredential = async (userId: unknown) =>
    !!(await User.findOne({ _id: userId, "emailIdentity.credential.data": { $exists: true, $ne: null } }).select("_id"));
  const dto = async (user: any) => senderDto(user, await hasCredential(user._id), flags());
  const assertNoActiveJob = async (userId: Types.ObjectId) => {
    if (await EmailJob.exists({ userId, active: true })) throw new ApiError(409, "JOB_ACTIVE", "Sender settings cannot change while an email job is running.");
  };

  r.get("/email", async (req, res) => {
    res.json({ settings: await dto(await currentUser(req)) });
  });

  /* ------------------------------------------------ Gmail OAuth (recommended) */
  /**
   * Browser navigation. Sends the signed-in user to Google to grant *send-only* access (gmail.send). The grant is
   * bound to this user through a one-time state record; the callback lives on the existing /auth/google/callback.
   */
  r.get("/email/gmail/connect", async (req, res) => {
    const back = (code: string) => res.redirect(302, `${config.frontendUrl}/settings/email?gmail=${code}`);
    if (!deps.googleClient) return back("unavailable");
    if (await EmailJob.exists({ userId: req.auth!.userId, active: true })) return back("job_active");
    const user = await currentUser(req);
    const cookieToken = randomToken(32);
    const state = randomToken(24), nonce = randomToken(24), verifier = randomBytes(48).toString("base64url");
    await OAuthState.create({ tokenHash: sha256(cookieToken), state, nonce, codeVerifier: verifier, purpose: "gmail", userId: user._id, expiresAt: new Date(Date.now() + 10 * 60_000) });
    res.cookie(OAUTH_COOKIE, cookieToken, { httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/api/auth/google", maxAge: 10 * 60_000 });
    res.redirect(302, deps.googleClient.gmailConnectUrl({
      state, nonce, codeChallenge: createHash("sha256").update(verifier).digest().toString("base64url"), loginHint: user.emailIdentity?.senderEmail || user.email,
    }));
  });

  /** Display name used in the From header (the address itself always comes from the connected Google account). */
  r.patch("/email", async (req, res) => {
    const body = parse(patchSchema, req.body);
    const user = await currentUser(req);
    if (!user.emailIdentity?.senderEmail) throw new ApiError(409, "SENDER_NOT_CONFIGURED", "Connect a sending account first.");
    await assertNoActiveJob(user._id);
    await User.updateOne({ _id: user._id }, { $set: { "emailIdentity.senderName": body.senderName } });
    res.json({ settings: await dto(await currentUser(req)) });
  });

  /* ------------------------------------------- Gmail App Password (opt-in) */
  r.put("/email", async (req, res) => {
    if (!config.allowAppPassword) {
      throw new ApiError(403, "APP_PASSWORD_DISABLED", "App passwords are not accepted on this server. Use “Connect Gmail” instead.");
    }
    const body = parse(putSchema, req.body);
    const user = await currentUser(req);
    await assertNoActiveJob(user._id);
    const wasSmtp = user.emailIdentity?.provider === "gmail_smtp";
    const had = wasSmtp && (await hasCredential(user._id));
    const pw = body.appPassword?.replace(/\s+/g, "");
    if (!had && !pw) throw new ApiError(400, "VALIDATION_ERROR", "An app password is required.", ["appPassword: required"]);
    if (pw !== undefined && !/^[A-Za-z0-9]{16}$/.test(pw)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Enter the 16-character Gmail App Password (not your normal password).", ["appPassword: must be a 16-character app password"]);
    }
    if (!wasSmtp) await revokeOAuthGrant(user._id); // replacing a Google grant: revoke it at Google
    const changed = pw !== undefined || !wasSmtp || body.senderEmail !== user.emailIdentity?.senderEmail;
    const set: Record<string, unknown> = {
      "emailIdentity.provider": "gmail_smtp",
      "emailIdentity.senderName": body.senderName,
      "emailIdentity.senderEmail": body.senderEmail,
    };
    if (pw !== undefined) set["emailIdentity.credential"] = encryptSecret(pw, config.encryptionKey);
    if (changed) Object.assign(set, { "emailIdentity.status": "unverified", "emailIdentity.verifiedAt": null, "emailIdentity.lastError": "" });
    await User.updateOne({ _id: user._id }, { $set: set });
    res.json({ settings: await dto(await currentUser(req)) });
  });

  /** Explicit connection test: authenticates against the provider but never sends a message. */
  r.post("/email/test", limiter(config, 10 * 60_000, 10, "Too many connection tests. Try again later."), async (req, res) => {
    const user = await User.findById(req.auth!.userId).select("+emailIdentity.credential");
    const id = user?.emailIdentity;
    if (!user || !id?.credential?.data || !id.senderEmail) throw new ApiError(409, "SENDER_NOT_CONFIGURED", "Connect a sending account first.");
    const mailer = mailerFactory({
      provider: id.provider ?? "gmail_oauth", senderName: id.senderName ?? "", senderEmail: id.senderEmail,
      secret: decryptSecret(id.credential as any, config.encryptionKey),
    });
    try {
      await mailer.verify();
      await User.updateOne({ _id: user._id }, { $set: { "emailIdentity.status": "verified", "emailIdentity.verifiedAt": new Date(), "emailIdentity.lastError": "" } });
    } catch (err) {
      const safe = safeSendError(err);
      await User.updateOne({ _id: user._id }, { $set: { "emailIdentity.status": "failed", "emailIdentity.verifiedAt": null, "emailIdentity.lastError": safe.message } });
    } finally {
      mailer.close();
    }
    res.json({ settings: await dto(await currentUser(req)) });
  });

  /** Disconnect: forgets the credential and, for Google, revokes the grant at Google (best effort). */
  r.delete("/email", async (req, res) => {
    await assertNoActiveJob(req.auth!.userId);
    await revokeOAuthGrant(req.auth!.userId);
    await User.updateOne({ _id: req.auth!.userId }, {
      $set: { "emailIdentity.senderEmail": "", "emailIdentity.senderName": "", "emailIdentity.status": "not_configured", "emailIdentity.verifiedAt": null, "emailIdentity.lastError": "", "emailIdentity.credential": null, "emailIdentity.provider": "gmail_oauth" },
    });
    res.json({ settings: await dto(await currentUser(req)) });
  });

  async function revokeOAuthGrant(userId: unknown) {
    const u = await User.findById(userId).select("+emailIdentity.credential");
    const id = u?.emailIdentity;
    if (id?.provider !== "gmail_oauth" || !id.credential?.data || !deps.googleClient) return;
    try { await deps.googleClient.revoke(decryptSecret(id.credential as any, config.encryptionKey)); } catch { /* already revoked or unreachable */ }
  }

  return r;
}
