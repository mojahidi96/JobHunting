import type { HydratedDocument } from "mongoose";
import { firstNameOf } from "../services/templateEngine.js";

/* Explicit DTO mappers: raw documents (hashes, credentials, __v, ownership ids) never reach the client. */

export const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

export function userDto(u: any) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    profilePhotoUrl: u.profilePhoto?.key ? `/api/profile/photo?v=${new Date(u.profilePhoto.updatedAt).getTime()}` : null,
    templateOnboardingCompletedAt: iso(u.templateOnboardingCompletedAt),
    onboardingCompleted: !!u.onboardingCompletedAt,
    emailVerified: !!u.emailVerified,
    googleLinked: !!u.googleSub,
    theme: u.theme ?? "system",
    // UI hints only; the backend re-checks authorization on every request.
    role: u.role === "admin" && u.emailVerified ? "admin" : "candidate",
    isOwner: !!u.isOwner && !!u.emailVerified,
    createdAt: iso(u.createdAt),
  };
}

/** Operational view for the Admin dashboard. No password hash, tokens, OTPs, credentials or profile content. */
export function adminUserDto(u: any) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role === "admin" ? "admin" : "candidate",
    isOwner: !!u.isOwner,
    status: u.status === "suspended" ? "suspended" : "active",
    emailVerified: !!u.emailVerified,
    googleLinked: !!u.googleSub,
    createdAt: iso(u.createdAt),
    lastLoginAt: iso(u.lastLoginAt),
    suspendedAt: iso(u.suspendedAt),
  };
}

export function auditDto(a: any) {
  return { id: String(a._id), action: a.action, actorEmail: a.actorEmail || null, targetEmail: a.targetEmail || null, meta: a.meta ?? {}, createdAt: iso(a.createdAt) };
}

export function profileDto(u: any) {
  const p = u.profile ?? {};
  return {
    name: u.name,
    loginEmail: u.email,
    profilePhotoUrl: userDto(u).profilePhotoUrl,
    theme: u.theme ?? "system",
    phone: p.phone ?? "",
    headline: p.headline ?? "",
    experienceYears: p.experienceYears ?? null,
    skillsSummary: p.skillsSummary ?? "",
    resumeUrl: p.resumeUrl ?? "",
    linkedinUrl: p.linkedinUrl ?? "",
    location: p.location ?? "",
    targetRoles: p.targetRoles ?? "",
    noticePeriod: p.noticePeriod ?? "",
    createdAt: iso(u.createdAt),
    updatedAt: iso(u.updatedAt),
  };
}

export function senderDto(u: any, hasCredential: boolean, flags: { gmailOAuthAvailable?: boolean; appPasswordAllowed?: boolean } = {}) {
  const e = u.emailIdentity ?? {};
  return {
    provider: e.provider ?? "gmail_oauth",
    gmailOAuthAvailable: !!flags.gmailOAuthAvailable,
    appPasswordAllowed: !!flags.appPasswordAllowed,
    loginEmail: u.email,
    senderName: e.senderName ?? "",
    senderEmail: e.senderEmail ?? "",
    status: e.status ?? "not_configured",
    verifiedAt: iso(e.verifiedAt),
    lastError: e.lastError || null,
    hasCredential,
  };
}

export function contactDto(c: any) {
  return {
    id: String(c._id),
    Name: c.Name,
    Company: c.Company,
    Email: c.Email,
    Role: c.Role,
    Link: c.Link ?? null,
    isSend: c.isSend ?? null,
    source: { type: c.source?.type, importId: c.source?.importId ? String(c.source.importId) : null },
    deliveryStatus: c.lastDelivery?.status ?? "pending",
    lastDelivery: c.lastDelivery
      ? { status: c.lastDelivery.status, at: iso(c.lastDelivery.at), error: c.lastDelivery.error ?? null }
      : null,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

export function importDto(i: any) {
  return {
    id: String(i._id),
    originalFilename: i.originalFilename,
    format: i.format,
    worksheetName: i.worksheetName ?? null,
    counts: i.counts,
    errors: (i.rowErrors ?? []).map((e: any) => ({ row: e.row, messages: e.messages })),
    storageRef: i.storageRef,
    importedAt: iso(i.createdAt),
  };
}

export function templateDto(t: any) {
  return {
    id: String(t._id),
    name: t.name,
    subject: t.subject,
    html: t.html,
    placeholderConfig: t.placeholderConfig ?? {},
    version: t.version,
    isDefault: !!t.isDefault,
    starterKey: t.starterKey ?? null,
    reviewedVersion: t.reviewedVersion ?? null,
    reviewed: t.reviewedVersion === t.version,
    reviewedAt: iso(t.reviewedAt),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export function jobDto(j: any) {
  return {
    jobId: String(j._id),
    status: j.status,
    totals: { selected: j.totals.selected, sent: j.totals.sent, failed: j.totals.failed, skipped: j.totals.skipped },
    sender: { provider: j.sender?.provider, senderName: j.sender?.senderName, senderEmail: j.sender?.senderEmail },
    template: j.template ? { templateId: String(j.template.templateId), name: j.template.name, version: j.template.version } : null,
    options: j.options,
    retryOf: j.retryOf ? String(j.retryOf) : null,
    createdAt: iso(j.createdAt),
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
  };
}

export function historyDto(h: any) {
  return {
    id: String(h._id),
    jobId: String(h.jobId),
    contactId: h.contactId ? String(h.contactId) : null,
    recipient: { Name: h.snapshot?.Name ?? "", Company: h.snapshot?.Company ?? "", Email: h.snapshot?.Email ?? "", Role: h.snapshot?.Role ?? "" },
    status: h.status,
    subject: h.subject ?? null,
    templateVersion: h.templateVersion ?? null,
    error: h.error?.code ? { code: h.error.code, message: h.error.message, retryable: !!h.error.retryable } : null,
    providerMessageId: h.providerMessageId ?? null,
    retryOf: h.retryOf ? String(h.retryOf) : null,
    retried: !!h.retried,
    createdAt: iso(h.createdAt),
    completedAt: iso(h.completedAt),
  };
}

export type Doc = HydratedDocument<any>;
export { firstNameOf };
