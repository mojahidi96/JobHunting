import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { senderDto } from "../lib/dto.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { isValidEmail, parse } from "../lib/validation.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import { limiter } from "../middleware/rateLimit.js";
import { EmailJob, User } from "../models/index.js";
import { safeSendError, type MailerFactory } from "../services/mailService.js";

const putSchema = z.object({
  senderName: z.string().trim().min(1).max(100),
  senderEmail: z.string().trim().toLowerCase().refine(isValidEmail, "must be a valid email address"),
  // Gmail App Password only (16 chars, shown by Google with spaces). Omit to keep the stored one.
  appPassword: z.string().trim().max(64).optional(),
}).strict();

export function settingsRoutes(config: Config, mailerFactory: MailerFactory) {
  const r = Router();
  r.use(requireAuth(config));

  const hasCredential = async (userId: unknown) =>
    !!(await User.findOne({ _id: userId, "emailIdentity.credential.data": { $exists: true, $ne: null } }).select("_id"));

  r.get("/email", async (req, res) => {
    const user = await currentUser(req);
    res.json({ settings: senderDto(user, await hasCredential(user._id)) });
  });

  r.put("/email", async (req, res) => {
    const body = parse(putSchema, req.body);
    const user = await currentUser(req);
    if (await EmailJob.exists({ userId: user._id, active: true })) {
      throw new ApiError(409, "JOB_ACTIVE", "Sender settings cannot change while an email job is running.");
    }
    const had = await hasCredential(user._id);
    const pw = body.appPassword?.replace(/\s+/g, "");
    if (!had && !pw) throw new ApiError(400, "VALIDATION_ERROR", "An app password is required.", ["appPassword: required"]);
    if (pw !== undefined && !/^[A-Za-z0-9]{16}$/.test(pw)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Enter the 16-character Gmail App Password (not your normal password).", ["appPassword: must be a 16-character app password"]);
    }
    const changed = pw !== undefined || body.senderEmail !== user.emailIdentity?.senderEmail;
    const set: Record<string, unknown> = {
      "emailIdentity.provider": "gmail_smtp",
      "emailIdentity.senderName": body.senderName,
      "emailIdentity.senderEmail": body.senderEmail,
    };
    if (pw !== undefined) set["emailIdentity.credential"] = encryptSecret(pw, config.encryptionKey);
    if (changed) Object.assign(set, { "emailIdentity.status": "unverified", "emailIdentity.verifiedAt": null, "emailIdentity.lastError": "" });
    await User.updateOne({ _id: user._id }, { $set: set });
    const fresh = await currentUser(req);
    res.json({ settings: senderDto(fresh, true) });
  });

  /** Explicit connection test: authenticates against the provider but never sends a message. */
  r.post("/email/test", limiter(config, 10 * 60_000, 10, "Too many connection tests. Try again later."), async (req, res) => {
    const user = await User.findById(req.auth!.userId).select("+emailIdentity.credential");
    const id = user?.emailIdentity;
    if (!user || !id?.credential?.data || !id.senderEmail) throw new ApiError(409, "SENDER_NOT_CONFIGURED", "Save your sender email and app password first.");
    const mailer = mailerFactory({
      senderName: id.senderName ?? "", senderEmail: id.senderEmail,
      password: decryptSecret(id.credential as any, config.encryptionKey),
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
    const fresh = await currentUser(req);
    res.json({ settings: senderDto(fresh, true) });
  });

  r.delete("/email", async (req, res) => {
    if (await EmailJob.exists({ userId: req.auth!.userId, active: true })) {
      throw new ApiError(409, "JOB_ACTIVE", "Sender settings cannot change while an email job is running.");
    }
    await User.updateOne({ _id: req.auth!.userId }, {
      $set: { "emailIdentity.senderEmail": "", "emailIdentity.senderName": "", "emailIdentity.status": "not_configured", "emailIdentity.verifiedAt": null, "emailIdentity.lastError": "", "emailIdentity.credential": null },
    });
    res.json({ settings: senderDto(await currentUser(req), false) });
  });

  return r;
}
