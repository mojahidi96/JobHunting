import { Types } from "mongoose";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { EmailHistory, EmailJob, EmailTemplate, RecruiterContact, User } from "../models/index.js";
import {
  configFor, renderForContact, resolveGlobals, tokensIn,
  type PlaceholderConfig, type ProfileValues, type TemplateInput,
} from "./templateEngine.js";

export interface SendOptions { delayMinMs: number; delayMaxMs: number; skipRowsMarkedNo: boolean }

export function normalizeOptions(config: Config, o?: Partial<SendOptions>): SendOptions {
  const clamp = (n: number) => Math.min(config.maxDelayBoundMs, Math.max(config.minDelayBoundMs, n));
  const min = clamp(o?.delayMinMs ?? config.defaultDelayMinMs);
  const max = Math.max(min, clamp(o?.delayMaxMs ?? config.defaultDelayMaxMs));
  return { delayMinMs: min, delayMaxMs: max, skipRowsMarkedNo: o?.skipRowsMarkedNo ?? true };
}

export function profileValuesOf(u: any): ProfileValues {
  const p = u.profile ?? {};
  return {
    SENDER_NAME: u.emailIdentity?.senderName || u.name || "",
    SENDER_EMAIL: u.emailIdentity?.senderEmail || "",
    CONTACT_NO: p.phone ?? "",
    RESUME_LINK: p.resumeUrl ?? "",
    LINKEDIN_LINK: p.linkedinUrl ?? "",
    HEADLINE: p.headline ?? "",
    SKILLS_SUMMARY: p.skillsSummary ?? "",
  };
}

export interface PreparedItem {
  contactId: string;
  snapshot: { Name: string; Company: string; Email: string; Role: string; Link: string | null };
  status: "eligible" | "skipped";
  skipReason?: string;
  subject: string;
  html: string;
  warnings: string[];
  unresolved: string[];
  previouslySentAt: Date | null;
}

export interface Problem { code: string; status: number; message: string; details?: string[] }

export interface Prepared {
  user: any;
  template: { id: string | null; name: string | null; version: number | null; reviewed: boolean | null; input: TemplateInput };
  globals: Record<string, string>;
  items: PreparedItem[];
  perSendFields: string[];
  problems: Problem[];
  options: SendOptions;
}

export interface PrepareInput {
  userId: Types.ObjectId;
  templateId?: string;
  inlineTemplate?: TemplateInput;
  contactIds: string[];
  perSendValues?: Record<string, string>;
  options?: Partial<SendOptions>;
  /** Send-only checks (verified sender, reviewed template, resolved placeholders). Preview reports them as problems too. */
}

export async function prepare(config: Config, input: PrepareInput): Promise<Prepared> {
  const user = await User.findById(input.userId).lean();
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");

  let tpl: Prepared["template"];
  if (input.templateId) {
    const t = await EmailTemplate.findOne({ _id: input.templateId, userId: input.userId }).lean();
    if (!t) throw new ApiError(404, "NOT_FOUND", "Template not found.");
    tpl = {
      id: String(t._id), name: t.name, version: t.version, reviewed: t.reviewedVersion === t.version,
      input: { subject: t.subject, html: t.html, placeholderConfig: (t.placeholderConfig ?? {}) as PlaceholderConfig },
    };
  } else {
    tpl = { id: null, name: null, version: null, reviewed: null, input: input.inlineTemplate! };
  }

  // Ownership: only contacts owned by this user are resolved; ids of other users simply are not found.
  const ids = [...new Set(input.contactIds)];
  const contacts = await RecruiterContact.find({ userId: input.userId, _id: { $in: ids.map((i) => new Types.ObjectId(i)) } }).lean();
  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const unknown = ids.filter((i) => !byId.has(i));
  if (unknown.length) throw new ApiError(404, "CONTACT_NOT_FOUND", "Some contacts were not found.", unknown);

  const options = normalizeOptions(config, input.options);
  const perSend = input.perSendValues ?? {};
  const globals = resolveGlobals(tpl.input, profileValuesOf(user), perSend);

  const used = tokensIn(tpl.input.subject, tpl.input.html);
  const perSendFields = used.filter((k) => configFor(k, tpl.input.placeholderConfig)?.source === "perSend");

  const emails = contacts.map((c) => c.emailLower);
  const prev = await EmailHistory.aggregate([
    { $match: { userId: input.userId, status: "sent", emailLower: { $in: emails } } },
    { $group: { _id: "$emailLower", at: { $max: "$completedAt" } } },
  ]);
  const prevMap = new Map<string, Date>(prev.map((p) => [p._id, p.at]));

  const seenEmails = new Set<string>();
  const items: PreparedItem[] = ids.map((id) => {
    const c = byId.get(id)!;
    const snapshot = { Name: c.Name, Company: c.Company, Email: c.Email, Role: c.Role, Link: c.Link ?? null };
    const r = renderForContact(tpl.input, snapshot, globals);
    let skipReason: string | undefined;
    if (options.skipRowsMarkedNo && c.isSend === "no") skipReason = "Contact is marked isSend = no.";
    else if (seenEmails.has(c.emailLower)) skipReason = "Duplicate address in this request.";
    if (!skipReason) seenEmails.add(c.emailLower);
    const warnings = [
      ...r.unresolved.map((k) => `{{${k}}} has no value`),
      ...r.unknown.map((k) => `Unknown placeholder {{${k}}}`),
    ];
    const prevAt = prevMap.get(c.emailLower) ?? null;
    if (prevAt) warnings.push(`You already emailed this address on ${prevAt.toISOString().slice(0, 10)}.`);
    return {
      contactId: id, snapshot, status: skipReason ? "skipped" : "eligible", skipReason,
      subject: r.subject, html: r.html, warnings, unresolved: [...r.unresolved, ...r.unknown.map((k) => `?${k}`)], previouslySentAt: prevAt,
    };
  });

  const problems: Problem[] = [];
  const idn = (user as any).emailIdentity;
  if (!idn?.senderEmail || idn.status !== "verified") {
    problems.push({ code: "SENDER_NOT_VERIFIED", status: 409, message: "Verify your sending identity in Email Sending Settings before sending." });
  }
  if (tpl.reviewed === false) {
    problems.push({ code: "TEMPLATE_NOT_REVIEWED", status: 409, message: "Review and confirm this template version before the first real send." });
  }
  const eligible = items.filter((i) => i.status === "eligible");
  const unresolvedMsgs = new Set<string>();
  for (const i of eligible) {
    for (const k of i.unresolved) {
      unresolvedMsgs.add(k.startsWith("?")
        ? `Unknown placeholder {{${k.slice(1)}}} — define it in the template's placeholder settings or remove it.`
        : (configFor(k, tpl.input.placeholderConfig)?.source === "contact"
          ? `{{${k}}} is empty for ${i.snapshot.Name}`
          : `{{${k}}} has no value (fill your profile, a manual value, or the per-send value; or allow an empty fallback)`));
    }
  }
  if (unresolvedMsgs.size) problems.push({ code: "PLACEHOLDERS_UNRESOLVED", status: 422, message: "Some placeholders are unresolved.", details: [...unresolvedMsgs].slice(0, 50) });
  if (!eligible.length) problems.push({ code: "NO_ELIGIBLE_RECIPIENTS", status: 422, message: "None of the selected contacts can be emailed." });

  return { user, template: tpl, globals, items, perSendFields, problems, options };
}

/** Creates the persistent job + recipient records. Throws JOB_ACTIVE if the user already has an active job. */
export async function createJob(
  config: Config,
  p: Prepared,
  idempotencyKey: string,
  opts: { retryOf?: Types.ObjectId; historyRetryOf?: Map<string, Types.ObjectId> } = {},
) {
  const user = p.user;
  const eligible = p.items.filter((i) => i.status === "eligible").length;
  const skipped = p.items.length - eligible;
  const since = new Date(Date.now() - 86_400_000);
  const used = await EmailHistory.countDocuments({ userId: user._id, createdAt: { $gt: since }, status: { $ne: "skipped" } });
  if (used + eligible > config.dailySendLimit) {
    const left = Math.max(0, config.dailySendLimit - used);
    throw new ApiError(429, "QUOTA_EXCEEDED", `Daily sending limit reached (${config.dailySendLimit} per 24 hours). You can queue ${left} more right now.`, [], { limit: config.dailySendLimit, remaining: left });
  }
  let job;
  try {
    job = await EmailJob.create({
      userId: user._id, status: "queued", active: true,
      totals: { selected: p.items.length, sent: 0, failed: 0, skipped },
      sender: { provider: user.emailIdentity.provider, senderName: user.emailIdentity.senderName, senderEmail: user.emailIdentity.senderEmail },
      template: p.template.id ? { templateId: new Types.ObjectId(p.template.id), name: p.template.name, version: p.template.version } : undefined,
      templateSnapshot: { subject: p.template.input.subject, html: p.template.input.html, placeholderConfig: p.template.input.placeholderConfig },
      globals: p.globals, options: p.options, idempotencyKey, retryOf: opts.retryOf ?? null,
    });
  } catch (e: any) {
    if (e?.code === 11000) {
      if (e.keyPattern?.idempotencyKey) throw new ApiError(409, "DUPLICATE_REQUEST", "This request was already submitted.");
      throw new ApiError(409, "JOB_ACTIVE", "Another email job is still running. Wait for it to finish.");
    }
    throw e;
  }
  const now = new Date();
  await EmailHistory.insertMany(p.items.map((i) => ({
    userId: user._id, jobId: job._id, contactId: new Types.ObjectId(i.contactId),
    snapshot: i.snapshot, emailLower: i.snapshot.Email.toLowerCase(),
    status: i.status === "skipped" ? "skipped" : "pending", subject: i.subject, templateVersion: p.template.version,
    error: i.status === "skipped" ? { code: "SKIPPED", message: i.skipReason, retryable: false } : undefined,
    completedAt: i.status === "skipped" ? now : undefined,
    retryOf: opts.historyRetryOf?.get(i.contactId) ?? null,
  })));
  await RecruiterContact.updateMany(
    { userId: user._id, _id: { $in: p.items.filter((i) => i.status === "skipped").map((i) => new Types.ObjectId(i.contactId)) } },
    { $set: { lastDelivery: { status: "skipped", at: now, jobId: job._id } } },
  );
  return job;
}
