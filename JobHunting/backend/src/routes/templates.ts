import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { templateDto } from "../lib/dto.js";
import { objectId, parse } from "../lib/validation.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import { EmailTemplate, User } from "../models/index.js";
import { STARTERS, getStarter } from "../services/starterTemplates.js";
import { BUILTIN_PLACEHOLDERS, CONTACT_FIELDS, PROFILE_FIELDS } from "../services/templateEngine.js";

const fieldConfig = z.object({
  source: z.enum(["contact", "profile", "manual", "perSend", "static"]),
  field: z.string().max(40).optional(),
  value: z.string().max(2000).optional(),
  allowEmpty: z.boolean().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.source === "contact" && !(CONTACT_FIELDS as readonly string[]).includes(c.field ?? "")) ctx.addIssue({ code: "custom", message: `field must be one of ${CONTACT_FIELDS.join(", ")}` });
  if (c.source === "profile" && !(PROFILE_FIELDS as readonly string[]).includes(c.field ?? "")) ctx.addIssue({ code: "custom", message: `field must be one of ${PROFILE_FIELDS.join(", ")}` });
  if ((c.source === "manual" || c.source === "static") && typeof c.value !== "string") ctx.addIssue({ code: "custom", message: "value is required" });
});
export const placeholderConfigSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/, "invalid placeholder name"), fieldConfig)
  .refine((o) => Object.keys(o).length <= 50, "too many placeholders")
  .refine((o) => !["__proto__", "constructor", "prototype"].some((k) => Object.prototype.hasOwnProperty.call(o, k)), "reserved placeholder name");

export const templateFields = {
  name: z.string().trim().min(1, "required").max(100),
  subject: z.string().trim().min(1, "required").max(300),
  html: z.string().trim().min(1, "required").max(100_000),
  placeholderConfig: placeholderConfigSchema,
};

export function templateRoutes(config: Config) {
  const r = Router();
  r.use(requireAuth(config));

  r.get("/placeholders", (_req, res) => {
    res.json({ builtins: BUILTIN_PLACEHOLDERS, contactFields: CONTACT_FIELDS, profileFields: PROFILE_FIELDS });
  });

  r.get("/starters", (_req, res) => {
    res.json({ items: STARTERS.map(({ key, name, subject, html, placeholderConfig }) => ({ key, name, subject, html, placeholderConfig })) });
  });

  r.get("/", async (req, res) => {
    const [items, user] = await Promise.all([
      EmailTemplate.find({ userId: req.auth!.userId }).sort({ isDefault: -1, name: 1 }).lean(),
      currentUser(req),
    ]);
    res.json({ items: items.map(templateDto), onboardingCompleted: !!user.templateOnboardingCompletedAt });
  });

  r.post("/", async (req, res) => {
    const body = parse(z.object({ ...templateFields, placeholderConfig: placeholderConfigSchema.default({}), starterKey: z.string().max(60).optional() }).strict(), req.body);
    const userId = req.auth!.userId;
    const first = !(await EmailTemplate.exists({ userId }));
    try {
      const t = await EmailTemplate.create({ ...body, userId, isDefault: first, starterKey: body.starterKey && getStarter(body.starterKey) ? body.starterKey : null });
      res.status(201).json({ item: templateDto(t) });
    } catch (e: any) {
      if (e?.code === 11000) throw new ApiError(409, "DUPLICATE_TEMPLATE_NAME", "You already have a template with this name.");
      throw e;
    }
  });

  const own = async (req: import("express").Request) => {
    const t = await EmailTemplate.findOne({ _id: parse(objectId, req.params.id), userId: req.auth!.userId });
    if (!t) throw new ApiError(404, "NOT_FOUND", "Template not found.");
    return t;
  };

  r.get("/:id", async (req, res) => { res.json({ item: templateDto(await own(req)) }); });

  r.patch("/:id", async (req, res) => {
    const body = parse(z.object({ ...templateFields, isDefault: z.literal(true) }).partial().strict(), req.body);
    const t = await own(req);
    const material = (body.subject !== undefined && body.subject !== t.subject)
      || (body.html !== undefined && body.html !== t.html)
      || (body.placeholderConfig !== undefined && JSON.stringify(body.placeholderConfig) !== JSON.stringify(t.placeholderConfig));
    if (body.name !== undefined) t.name = body.name;
    if (body.subject !== undefined) t.subject = body.subject;
    if (body.html !== undefined) t.html = body.html;
    if (body.placeholderConfig !== undefined) { t.placeholderConfig = body.placeholderConfig; t.markModified("placeholderConfig"); }
    // A change to what is sent bumps the version, which invalidates the previous review confirmation.
    if (material) t.version += 1;
    if (body.isDefault) {
      await EmailTemplate.updateMany({ userId: t.userId, _id: { $ne: t._id } }, { $set: { isDefault: false } });
      t.isDefault = true;
    }
    try { await t.save(); }
    catch (e: any) { if (e?.code === 11000) throw new ApiError(409, "DUPLICATE_TEMPLATE_NAME", "You already have a template with this name."); throw e; }
    res.json({ item: templateDto(t) });
  });

  r.post("/:id/duplicate", async (req, res) => {
    const t = await own(req);
    const base = `${t.name.slice(0, 90)} (copy)`;
    let name = base, n = 2;
    while (await EmailTemplate.exists({ userId: t.userId, name })) name = `${base} ${n++}`;
    const copy = await EmailTemplate.create({ userId: t.userId, name, subject: t.subject, html: t.html, placeholderConfig: t.placeholderConfig, starterKey: t.starterKey });
    res.status(201).json({ item: templateDto(copy) });
  });

  r.post("/:id/reset", async (req, res) => {
    const t = await own(req);
    const s = t.starterKey ? getStarter(t.starterKey) : null;
    if (!s) throw new ApiError(409, "NO_STARTER", "This template was not created from a starter.");
    t.subject = s.subject; t.html = s.html; t.placeholderConfig = s.placeholderConfig; t.markModified("placeholderConfig");
    t.version += 1;
    await t.save();
    res.json({ item: templateDto(t) });
  });

  /** Explicit confirmation that the user reviewed THIS version of the template before real sending. */
  r.post("/:id/review", async (req, res) => {
    const body = parse(z.object({ confirmation: z.literal(true), version: z.number().int() }), req.body);
    const t = await own(req);
    if (body.version !== t.version) throw new ApiError(409, "VERSION_MISMATCH", "The template changed. Reload and review the latest version.");
    t.reviewedVersion = t.version;
    t.reviewedAt = new Date();
    await t.save();
    await User.updateOne({ _id: req.auth!.userId, templateOnboardingCompletedAt: null }, { $set: { templateOnboardingCompletedAt: new Date() } });
    res.json({ item: templateDto(t) });
  });

  r.delete("/:id", async (req, res) => {
    const t = await own(req);
    await t.deleteOne();
    if (t.isDefault) {
      const next = await EmailTemplate.findOne({ userId: t.userId }).sort({ createdAt: 1 });
      if (next) { next.isDefault = true; await next.save(); }
    }
    res.json({ ok: true });
  });

  return r;
}
