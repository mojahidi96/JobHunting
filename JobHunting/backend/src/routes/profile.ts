import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { profileDto, userDto, iso } from "../lib/dto.js";
import { parse, urlOrEmpty } from "../lib/validation.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import { EmailHistory, EmailJob, EmailTemplate, ImportRecord, RecruiterContact, Session, User } from "../models/index.js";
import { clearSessionCookie, verifyPassword } from "../services/authService.js";

const profileSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(40).regex(/^[0-9+()\-.\s]*$/, "may only contain digits and + ( ) - ."),
  headline: z.string().trim().max(160),
  experienceYears: z.number().min(0).max(70).nullable(),
  skillsSummary: z.string().trim().max(2000),
  resumeUrl: urlOrEmpty(),
  linkedinUrl: urlOrEmpty(),
  location: z.string().trim().max(120),
  targetRoles: z.string().trim().max(300),
  noticePeriod: z.string().trim().max(120),
}).partial().strict();

const PHOTO_MAX = 2 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PHOTO_MAX, files: 1 } });

/** Content sniffing: never trust the client-declared MIME type or file name. */
function sniffImage(b: Buffer): { ext: "png" | "jpg" | "webp"; mime: string } | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
}
const KEY_RE = /^[a-f\d]{24}-[a-f\d]{16}\.(png|jpg|webp)$/;

export function profileRoutes(config: Config) {
  const r = Router();
  const avatarDir = path.join(config.uploadDir, "avatars");

  r.use(requireAuth(config));

  r.get("/profile", async (req, res) => {
    res.json({ profile: profileDto(await currentUser(req)) });
  });

  r.patch("/profile", async (req, res) => {
    const body = parse(profileSchema, req.body);
    const user = await currentUser(req);
    const { name, theme, ...rest } = body;
    if (name !== undefined) user.name = name;
    if (theme !== undefined) user.theme = theme;
    for (const [k, v] of Object.entries(rest)) (user.profile as any)[k] = v;
    await user.save();
    res.json({ profile: profileDto(user) });
  });

  /** Minimal first-run onboarding: only a name is required; everything else is optional and can be filled in later. */
  r.post("/onboarding/complete", async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(100),
      headline: z.string().trim().max(160).optional(),
      experienceYears: z.number().min(0).max(70).nullable().optional(),
      skillsSummary: z.string().trim().max(2000).optional(),
    }).strict(), req.body);
    const user = await currentUser(req);
    user.name = body.name;
    if (body.headline !== undefined) user.profile!.headline = body.headline;
    if (body.experienceYears !== undefined) user.profile!.experienceYears = body.experienceYears;
    if (body.skillsSummary !== undefined) user.profile!.skillsSummary = body.skillsSummary;
    if (!user.onboardingCompletedAt) user.onboardingCompletedAt = new Date();
    await user.save();
    res.json({ user: userDto(user), profile: profileDto(user) });
  });

  r.post("/profile/photo", upload.single("photo"), async (req, res) => {
    if (!req.file) throw new ApiError(400, "VALIDATION_ERROR", 'Upload a file in the "photo" field.');
    const kind = sniffImage(req.file.buffer);
    if (!kind) throw new ApiError(415, "UNSUPPORTED_FILE_TYPE", "Photo must be a PNG, JPEG or WebP image.");
    const user = await currentUser(req);
    const key = `${user.id}-${randomBytes(8).toString("hex")}.${kind.ext}`;
    await fs.mkdir(avatarDir, { recursive: true });
    await fs.writeFile(path.join(avatarDir, key), req.file.buffer, { mode: 0o600 });
    const old = user.profilePhoto?.key;
    user.profilePhoto = { key, mime: kind.mime, updatedAt: new Date() } as any;
    await user.save();
    if (old && KEY_RE.test(old)) await fs.rm(path.join(avatarDir, old), { force: true });
    res.json({ profile: profileDto(user) });
  });

  r.delete("/profile/photo", async (req, res) => {
    const user = await currentUser(req);
    const old = user.profilePhoto?.key;
    user.profilePhoto = null as any;
    await user.save();
    if (old && KEY_RE.test(old)) await fs.rm(path.join(avatarDir, old), { force: true });
    res.json({ profile: profileDto(user) });
  });

  // Photos are private: served only to their owner, from a generated key (never a client path).
  r.get("/profile/photo", async (req, res) => {
    const user = await currentUser(req);
    const key = user.profilePhoto?.key;
    if (!key || !KEY_RE.test(key)) throw new ApiError(404, "NOT_FOUND", "No profile photo.");
    res.setHeader("Content-Type", user.profilePhoto!.mime ?? "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(path.join(avatarDir, key), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  /* Account data portability and deletion */
  r.get("/account/export", async (req, res) => {
    const uid = req.auth!.userId;
    const user = await currentUser(req);
    const [contacts, imports, templates, jobs, history] = await Promise.all([
      RecruiterContact.find({ userId: uid }).lean(), ImportRecord.find({ userId: uid }).lean(),
      EmailTemplate.find({ userId: uid }).lean(), EmailJob.find({ userId: uid }).lean(), EmailHistory.find({ userId: uid }).lean(),
    ]);
    res.setHeader("Content-Disposition", 'attachment; filename="jobhunting-account-export.json"');
    res.json({
      exportedAt: new Date().toISOString(), account: userDto(user), profile: profileDto(user),
      contacts, imports, templates,
      jobs: jobs.map((j) => ({ ...j, userId: undefined, globals: undefined })),
      history,
    });
  });

  r.delete("/account", async (req, res) => {
    const b = parse(z.object({ password: z.string().max(128).optional(), confirmEmail: z.string().max(254).optional(), confirm: z.literal(true) }).strict(), req.body);
    const user = await User.findById(req.auth!.userId).select("+passwordHash");
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
    // Accounts with a password must confirm it; Google/OTP-only accounts confirm by typing their email address.
    const confirmed = user.passwordHash
      ? !!b.password && (await verifyPassword(user.passwordHash, b.password))
      : (b.confirmEmail ?? "").trim().toLowerCase() === user.email;
    if (!confirmed) throw new ApiError(403, "INVALID_CREDENTIALS", user.passwordHash ? "Incorrect password." : "Type your account email address to confirm.");
    if (user.isOwner) throw new ApiError(409, "OWNER_PROTECTED", "The owner account can't be deleted from here. Transfer ownership first.");
    const active = await EmailJob.exists({ userId: user._id, active: true });
    if (active) throw new ApiError(409, "JOB_ACTIVE", "An email job is still running. Wait for it to finish first.");
    const uid = user._id;
    const key = user.profilePhoto?.key;
    await Promise.all([
      RecruiterContact.deleteMany({ userId: uid }), ImportRecord.deleteMany({ userId: uid }), EmailTemplate.deleteMany({ userId: uid }),
      EmailJob.deleteMany({ userId: uid }), EmailHistory.deleteMany({ userId: uid }), Session.deleteMany({ userId: uid }),
    ]);
    await User.deleteOne({ _id: uid });
    if (key && KEY_RE.test(key)) await fs.rm(path.join(avatarDir, key), { force: true });
    clearSessionCookie(config, res);
    res.json({ ok: true, deletedAt: iso(new Date()) });
  });

  return r;
}
