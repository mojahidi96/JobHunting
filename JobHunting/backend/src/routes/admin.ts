import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { adminUserDto, auditDto } from "../lib/dto.js";
import { escapeRegex, isValidEmail, objectId, parse } from "../lib/validation.js";
import { requireAdmin, requireAuth, requireOwner } from "../middleware/auth.js";
import { limiter } from "../middleware/rateLimit.js";
import { AuditLog, EmailHistory, EmailJob, EmailTemplate, RecruiterContact, Session, User } from "../models/index.js";
import { audit } from "../services/auditService.js";
import { buildTransport, otpMessage } from "../services/authMailer.js";
import { clearSmtp, describeSmtp, loadSmtp, recordTest, safeMailError, saveSmtp, type SmtpSettings } from "../services/emailSettings.js";

export type SmtpTester = (smtp: SmtpSettings, to: string) => Promise<void>;

/** Real delivery check: verifies the connection and sends a test message to the owner. */
export const defaultSmtpTester: SmtpTester = async (smtp, to) => {
  const t = buildTransport(smtp);
  try {
    await t.verify();
    await t.sendMail({ ...otpMessage(smtp.from, to, "000000", 5), subject: "JobHunting email delivery test", text: "This is a test message from JobHunting. Email delivery is working.", html: "<p>This is a test message from JobHunting. Email delivery is working.</p>" });
  } finally { t.close(); }
};

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(["admin", "candidate"]).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  sort: z.enum(["createdAt", "name", "email", "lastLoginAt"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const idParam = z.object({ id: objectId });
const roleBody = z.object({ role: z.enum(["admin", "candidate"]) }).strict();
const statusBody = z.object({ status: z.enum(["active", "suspended"]) }).strict();
const smtpBody = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, "must be a hostname"),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(254),
  from: z.string().trim().min(3).max(300).refine((v) => !/[\r\n]/.test(v), "invalid"),
  pass: z.string().min(1).max(200).optional(),
}).strict();

export function adminRoutes(config: Config, smtpTester: SmtpTester = defaultSmtpTester) {
  const r = Router();
  // Deny by default: everything below needs a valid session AND the admin role, re-read from the database per request.
  r.use(requireAuth(config), requireAdmin);
  const writeLimit = limiter(config, 60_000, 30, "Too many admin actions. Slow down.");

  async function me(req: import("express").Request) {
    const u = await User.findById(req.auth!.userId).select("email").lean();
    return { id: req.auth!.userId, email: u?.email ?? "" };
  }

  /* ------------------------------------------------------------- candidates */
  r.get("/users", async (req, res) => {
    const q = parse(listQuery, req.query);
    const filter: Record<string, unknown> = {};
    // Accounts created before roles existed have no `role`/`status` field: treat "missing" as candidate/active.
    if (q.role) filter.role = q.role === "admin" ? "admin" : { $ne: "admin" };
    if (q.status) filter.status = q.status === "suspended" ? "suspended" : { $ne: "suspended" };
    if (q.q) { const re = new RegExp(escapeRegex(q.q), "i"); filter.$or = [{ name: re }, { email: re }]; }
    const dir = q.order === "asc" ? 1 : -1;
    const [items, total] = await Promise.all([
      User.find(filter).sort({ [q.sort]: dir, _id: dir }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      User.countDocuments(filter),
    ]);
    res.json({ items: items.map(adminUserDto), total, page: q.page, pageSize: q.pageSize });
  });

  r.get("/users/:id", async (req, res) => {
    const { id } = parse(idParam, req.params);
    const u = await User.findById(id).select("+passwordHash").lean();
    if (!u) throw new ApiError(404, "NOT_FOUND", "Account not found.");
    const [contacts, templates, jobs, sent] = await Promise.all([
      RecruiterContact.countDocuments({ userId: id }), EmailTemplate.countDocuments({ userId: id }),
      EmailJob.countDocuments({ userId: id }), EmailHistory.countDocuments({ userId: id, status: "sent" }),
    ]);
    res.json({
      user: { ...adminUserDto(u), hasPassword: !!u.passwordHash, senderStatus: u.emailIdentity?.status ?? "not_configured", onboardingCompleted: !!u.onboardingCompletedAt },
      usage: { contacts, templates, jobs, emailsSent: sent }, // counts only: admins never see another user's contacts or messages
    });
  });

  /** Promote / demote. Owner-only, enforced here regardless of what the UI shows. */
  r.patch("/users/:id/role", requireOwner, writeLimit, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { role } = parse(roleBody, req.body);
    const target = await User.findById(id);
    if (!target) throw new ApiError(404, "NOT_FOUND", "Account not found.");
    if (target.isOwner || (config.ownerEmail && target.email === config.ownerEmail)) throw new ApiError(409, "OWNER_PROTECTED", "The owner account's role can't be changed.");
    if (String(target._id) === String(req.auth!.userId)) throw new ApiError(409, "SELF_CHANGE", "You can't change your own role.");
    if (target.role === role) return void res.json({ user: adminUserDto(target) });
    if (role === "admin") {
      if (!target.emailVerified) throw new ApiError(409, "EMAIL_UNVERIFIED", "Only accounts with a verified email address can become Admin.");
      if (target.status === "suspended") throw new ApiError(409, "ACCOUNT_SUSPENDED", "Reactivate this account before promoting it.");
    }
    target.role = role;
    await target.save();
    await audit({ actor: await me(req), action: role === "admin" ? "role.promote" : "role.demote", target: { id: target._id, email: target.email }, meta: { from: role === "admin" ? "candidate" : "admin", to: role } });
    res.json({ user: adminUserDto(target) });
  });

  /** Suspend / reactivate. Admins may manage candidates; only the owner may act on another Admin. */
  r.patch("/users/:id/status", writeLimit, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { status } = parse(statusBody, req.body);
    const target = await User.findById(id);
    if (!target) throw new ApiError(404, "NOT_FOUND", "Account not found.");
    if (target.isOwner || (config.ownerEmail && target.email === config.ownerEmail)) throw new ApiError(409, "OWNER_PROTECTED", "The owner account can't be suspended.");
    if (String(target._id) === String(req.auth!.userId)) throw new ApiError(409, "SELF_CHANGE", "You can't change your own account status.");
    if (target.role === "admin" && !req.auth!.isOwner) throw new ApiError(403, "OWNER_ONLY", "Only the application owner can change another Admin's status.");
    if (target.status !== status) {
      target.status = status;
      target.suspendedAt = status === "suspended" ? new Date() : null;
      await target.save();
      if (status === "suspended") await Session.deleteMany({ userId: target._id }); // takes effect immediately
      await audit({ actor: await me(req), action: status === "suspended" ? "account.suspend" : "account.reactivate", target: { id: target._id, email: target.email } });
    }
    res.json({ user: adminUserDto(target) });
  });

  r.get("/audit", async (req, res) => {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict(), req.query);
    const [items, total] = await Promise.all([
      AuditLog.find().sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      AuditLog.countDocuments(),
    ]);
    res.json({ items: items.map(auditDto), total, page: q.page, pageSize: q.pageSize });
  });

  /* ------------------------------------------- email delivery (owner only) */
  r.get("/settings/email", requireOwner, async (_req, res) => { res.json({ settings: await describeSmtp(config) }); });

  r.put("/settings/email", requireOwner, writeLimit, async (req, res) => {
    const b = parse(smtpBody, req.body);
    const ok = await saveSmtp(config, b, req.auth!.userId);
    if (!ok) throw new ApiError(400, "VALIDATION_ERROR", "The request is invalid.", ["pass: required the first time"]);
    await audit({ actor: await me(req), action: "settings.email.update", meta: { host: b.host, port: b.port, user: b.user, passwordChanged: !!b.pass } });
    res.json({ settings: await describeSmtp(config) });
  });

  r.delete("/settings/email", requireOwner, writeLimit, async (req, res) => {
    await clearSmtp();
    await audit({ actor: await me(req), action: "settings.email.clear" });
    res.json({ settings: await describeSmtp(config) });
  });

  r.post("/settings/email/test", requireOwner, limiter(config, 10 * 60_000, 10, "Too many tests. Try again later."), async (req, res) => {
    const found = await loadSmtp(config);
    if (!found) throw new ApiError(409, "NOT_CONFIGURED", "No email delivery is configured yet. Save the settings first.");
    const who = await me(req);
    if (!isValidEmail(who.email)) throw new ApiError(409, "NOT_CONFIGURED", "Your account has no valid email address.");
    try {
      await smtpTester(found.smtp, who.email);
      await recordTest(true, `Test message sent to ${who.email}.`);
      await audit({ actor: who, action: "settings.email.test", meta: { ok: true } });
      res.json({ ok: true, message: `Test message sent to ${who.email}. Check your inbox.`, settings: await describeSmtp(config) });
    } catch (e) {
      const safe = safeMailError(e);
      console.error("Email delivery test failed:", safe.code); // class only, never the provider response
      await recordTest(false, safe.message);
      await audit({ actor: who, action: "settings.email.test", meta: { ok: false, code: safe.code } });
      res.json({ ok: false, code: safe.code, message: safe.message, settings: await describeSmtp(config) });
    }
  });

  return r;
}
