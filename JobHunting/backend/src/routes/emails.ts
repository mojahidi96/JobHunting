import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { historyDto, jobDto, senderDto } from "../lib/dto.js";
import { escapeRegex, objectId, parse } from "../lib/validation.js";
import { requireAuth } from "../middleware/auth.js";
import { limiter } from "../middleware/rateLimit.js";
import { EmailHistory, EmailJob } from "../models/index.js";
import type { JobRunner } from "../services/jobRunner.js";
import { createJob, prepare, type Prepared } from "../services/sendService.js";
import { placeholderConfigSchema, templateFields } from "./templates.js";

const perSendValues = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/), z.string().max(2000))
  .refine((o) => !["__proto__", "constructor", "prototype"].some((k) => Object.prototype.hasOwnProperty.call(o, k)), "reserved name");
const optionsSchema = z.object({
  delayMinMs: z.number().finite().optional(),
  delayMaxMs: z.number().finite().optional(),
  skipRowsMarkedNo: z.boolean().optional(),
}).strict();
const contactIds = z.array(objectId).min(1).max(500);
const inline = z.object({ subject: templateFields.subject, html: templateFields.html, placeholderConfig: placeholderConfigSchema.default({}) });

const previewSchema = z.object({
  templateId: objectId.optional(),
  template: inline.optional(),
  contactIds,
  perSendValues: perSendValues.optional(),
  options: optionsSchema.optional(),
}).strict().refine((b) => !!b.templateId !== !!b.template, "provide exactly one of templateId or template");

const sendSchema = z.object({
  templateId: objectId,
  contactIds,
  perSendValues: perSendValues.optional(),
  options: optionsSchema.optional(),
  confirmation: z.unknown().optional(),
  idempotencyKey: z.string().trim().min(8).max(100),
}).strict(); // note: no `from`/`to` fields exist; unknown keys are rejected

const BODIES_PER_PREVIEW = 10;

function previewBody(p: Prepared, sender: ReturnType<typeof senderDto>) {
  const eligible = p.items.filter((i) => i.status === "eligible").length;
  return {
    sender: { provider: sender.provider, loginEmail: sender.loginEmail, senderName: sender.senderName, senderEmail: sender.senderEmail, status: sender.status },
    template: { id: p.template.id, name: p.template.name, version: p.template.version, reviewed: p.template.reviewed },
    summary: { selected: p.items.length, eligible, skipped: p.items.length - eligible },
    options: p.options,
    perSendFields: p.perSendFields,
    items: p.items.map((i, idx) => ({
      contactId: i.contactId, to: i.snapshot.Email, name: i.snapshot.Name, company: i.snapshot.Company,
      status: i.status, skipReason: i.skipReason ?? null, subject: i.subject,
      html: idx < BODIES_PER_PREVIEW ? i.html : null,
      warnings: i.warnings, previouslySentAt: i.previouslySentAt ? i.previouslySentAt.toISOString() : null,
    })),
    problems: p.problems.map(({ code, message, details }) => ({ code, message, details: details ?? [] })),
    canSend: p.problems.length === 0,
  };
}

const historyQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["sent", "failed", "skipped", "pending"]).optional(),
  jobId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(["createdAt", "status", "Name", "Company", "Email"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function emailRoutes(config: Config, runner: JobRunner) {
  const r = Router();
  r.use(requireAuth(config));
  const sendLimit = limiter(config, 60_000, 10, "Too many send requests. Slow down.");

  const senderOf = (p: Prepared) => senderDto(p.user, true);

  r.post("/preview", async (req, res) => {
    const b = parse(previewSchema, req.body);
    const p = await prepare(config, {
      userId: req.auth!.userId, templateId: b.templateId, inlineTemplate: b.template,
      contactIds: b.contactIds, perSendValues: b.perSendValues, options: b.options,
    });
    res.json(previewBody(p, senderOf(p)));
  });

  r.post("/send", sendLimit, async (req, res) => {
    const b = parse(sendSchema, req.body);
    if (b.confirmation !== true) throw new ApiError(400, "CONFIRMATION_REQUIRED", "Sending requires confirmation: true.");
    const userId = req.auth!.userId;

    // Idempotent replay: the same key returns the original job and never sends again.
    const existing = await EmailJob.findOne({ userId, idempotencyKey: b.idempotencyKey });
    if (existing) { res.status(200).json({ job: jobDto(existing), replayed: true }); return; }

    const p = await prepare(config, { userId, templateId: b.templateId, contactIds: b.contactIds, perSendValues: b.perSendValues, options: b.options });
    if (p.problems.length) {
      const first = p.problems[0];
      throw new ApiError(first.status, first.code, first.message, first.details ?? p.problems.map((x) => x.message));
    }
    const job = await createJob(config, p, b.idempotencyKey);
    runner.start(String(job._id));
    res.status(202).json({ job: jobDto(job), replayed: false });
  });

  /* ------------------------------------------------------------- jobs */
  r.get("/jobs", async (req, res) => {
    const items = await EmailJob.find({ userId: req.auth!.userId }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ items: items.map(jobDto) });
  });

  const ownJob = async (req: import("express").Request) => {
    const j = await EmailJob.findOne({ _id: parse(objectId, req.params.jobId), userId: req.auth!.userId }).lean();
    if (!j) throw new ApiError(404, "JOB_NOT_FOUND", "Job not found.");
    return j;
  };

  r.get("/jobs/:jobId", async (req, res) => {
    const job = await ownJob(req);
    const recipients = await EmailHistory.find({ userId: req.auth!.userId, jobId: job._id }).sort({ _id: 1 }).lean();
    res.json({ job: jobDto(job), recipients: recipients.map(historyDto) });
  });

  r.post("/jobs/:jobId/retry", sendLimit, async (req, res) => {
    const b = parse(z.object({
      confirmation: z.unknown().optional(),
      idempotencyKey: z.string().trim().min(8).max(100),
      historyIds: z.array(objectId).min(1).max(500).optional(),
    }).strict(), req.body);
    if (b.confirmation !== true) throw new ApiError(400, "CONFIRMATION_REQUIRED", "Retrying requires confirmation: true.");
    const userId = req.auth!.userId;
    const old = await ownJob(req);

    const existing = await EmailJob.findOne({ userId, idempotencyKey: b.idempotencyKey });
    if (existing) { res.status(200).json({ job: jobDto(existing), replayed: true }); return; }
    if (old.active) throw new ApiError(409, "JOB_ACTIVE", "This job is still running.");

    // Only definite, non-uncertain failures that have not already been retried.
    const filter: Record<string, unknown> = { userId, jobId: old._id, status: "failed", "error.retryable": true, retried: false };
    if (b.historyIds) filter._id = { $in: b.historyIds.map((i) => new Types.ObjectId(i)) };
    const failed = await EmailHistory.find(filter).lean();
    if (!failed.length) throw new ApiError(422, "NOTHING_TO_RETRY", "No retryable failures were found.");

    const contactIdList = failed.filter((f) => f.contactId).map((f) => String(f.contactId));
    const p = await prepare(config, {
      userId, inlineTemplate: {
        subject: old.templateSnapshot!.subject!, html: old.templateSnapshot!.html!,
        placeholderConfig: (old.templateSnapshot!.placeholderConfig ?? {}) as any,
      },
      contactIds: contactIdList.length ? contactIdList : ["000000000000000000000000"],
      options: old.options as any,
    }).catch((e) => {
      if (e instanceof ApiError && e.code === "CONTACT_NOT_FOUND") throw new ApiError(409, "CONTACT_DELETED", "Some contacts were deleted and cannot be retried.", e.details as string[]);
      throw e;
    });
    // Re-use the original job's resolved values and template version for an identical message.
    p.globals = { ...(old.globals as unknown as Record<string, string>) }; // lean() returns the Map as a plain object
    p.template = { ...p.template, id: old.template?.templateId ? String(old.template.templateId) : null, name: old.template?.name ?? null, version: old.template?.version ?? null };
    const blocking = p.problems.filter((x) => x.code === "SENDER_NOT_VERIFIED" || x.code === "NO_ELIGIBLE_RECIPIENTS");
    if (blocking.length) throw new ApiError(blocking[0].status, blocking[0].code, blocking[0].message);

    const retryOf = new Map(failed.map((f) => [String(f.contactId), f._id]));
    const job = await createJob(config, p, b.idempotencyKey, { retryOf: old._id, historyRetryOf: retryOf });
    await EmailHistory.updateMany({ _id: { $in: failed.map((f) => f._id) }, userId }, { $set: { retried: true } });
    runner.start(String(job._id));
    res.status(202).json({ job: jobDto(job), replayed: false });
  });

  /* ---------------------------------------------------------- history */
  r.get("/history", async (req, res) => {
    const q = parse(historyQuery, req.query);
    const userId = req.auth!.userId;
    const base: Record<string, unknown> = { userId };
    if (q.q) {
      const re = new RegExp(escapeRegex(q.q), "i");
      base.$or = [{ "snapshot.Name": re }, { "snapshot.Email": re }, { "snapshot.Company": re }, { "snapshot.Role": re }];
    }
    if (q.jobId) base.jobId = new Types.ObjectId(q.jobId);
    if (q.from || q.to) base.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const filter = q.status ? { ...base, status: q.status } : base;
    const sortKey = q.sort === "createdAt" || q.sort === "status" ? q.sort : `snapshot.${q.sort}`;

    const [items, total, grouped] = await Promise.all([
      EmailHistory.find(filter).sort({ [sortKey]: q.order === "asc" ? 1 : -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      EmailHistory.countDocuments(filter),
      EmailHistory.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const n = (s: string) => grouped.find((g) => g._id === s)?.n ?? 0;
    const sent = n("sent"), failed = n("failed"), skipped = n("skipped");
    res.json({
      items: items.map(historyDto), total, page: q.page, pageSize: q.pageSize,
      counts: { attempted: sent + failed, sent, failed, skipped },
    });
  });

  r.get("/history/:id", async (req, res) => {
    const h = await EmailHistory.findOne({ _id: parse(objectId, req.params.id), userId: req.auth!.userId }).lean();
    if (!h) throw new ApiError(404, "NOT_FOUND", "History record not found.");
    res.json({ item: historyDto(h) });
  });

  return r;
}
