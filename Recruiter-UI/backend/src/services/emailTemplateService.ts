import type { Config } from "../config/env.js";
import type { EmailTemplate } from "../types/index.js";
import type { WorkbookRecruiter } from "./workbookService.js";

export const PLACEHOLDERS = [
  "Name", "firstName", "Company", "Role", "Email", "Link",
  "SENDER_NAME", "SENDER_EMAIL", "CONTACT_NO", "RESUME_LINK", "LINKEDIN_LINK",
] as const;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const isValidEmail = (e: string) => EMAIL_RE.test(e);

export function firstNameOf(name: string): string {
  return name.split(/\s+/).find(Boolean) ?? "";
}

type Sender = Pick<Config, "senderName" | "senderEmail" | "contactNo" | "resumeLink" | "linkedinLink">;

function valuesFor(r: WorkbookRecruiter, s: Sender): Record<string, string> {
  return {
    Name: r.Name,
    firstName: firstNameOf(r.Name),
    Company: r.Company,
    Role: r.Role,
    Email: r.Email,
    Link: r.Link ?? "",
    SENDER_NAME: s.senderName,
    SENDER_EMAIL: s.senderEmail,
    CONTACT_NO: s.contactNo,
    RESUME_LINK: s.resumeLink,
    LINKEDIN_LINK: s.linkedinLink,
  };
}

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function substitute(text: string, vals: Record<string, string>, escape: boolean, unknown: Set<string>): string {
  // Single pass: substituted values are never re-scanned for tokens.
  return text.replace(TOKEN_RE, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vals, key)) {
      unknown.add(key);
      return match;
    }
    return escape ? escapeHtml(vals[key]) : vals[key];
  });
}

export interface RenderedEmail {
  recruiterId: string;
  to: string;
  subject: string;
  html: string;
  warnings: string[];
}

export function recipientProblems(r: WorkbookRecruiter): string[] {
  const p: string[] = [];
  for (const c of ["Name", "Company", "Email", "Role"] as const) {
    if (!r[c]) p.push(`Missing required field: ${c}`);
  }
  if (r.Email && !isValidEmail(r.Email)) p.push("Email address is malformed");
  return p;
}

export function renderEmail(r: WorkbookRecruiter, template: EmailTemplate, sender: Sender): RenderedEmail {
  const vals = valuesFor(r, sender);
  const unknown = new Set<string>();
  const subject = substitute(template.subject, vals, false, unknown).replace(/[\r\n]+/g, " ");
  const html = substitute(template.html, vals, true, unknown);
  const warnings = recipientProblems(r);
  for (const u of unknown) warnings.push(`Unknown placeholder: {{${u}}}`);
  const used = (key: string) => new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`).test(template.subject + template.html);
  for (const key of ["SENDER_NAME", "SENDER_EMAIL", "CONTACT_NO", "RESUME_LINK", "LINKEDIN_LINK"] as const) {
    if (used(key) && !vals[key]) warnings.push(`${key} is not configured on the server`);
  }
  if (used("Link") && !r.Link) warnings.push("Link is empty for this recruiter");
  return { recruiterId: r.id, to: r.Email, subject, html, warnings };
}
