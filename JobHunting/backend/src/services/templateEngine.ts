import { escapeHtml, sanitizeEmailHtml } from "../lib/html.js";

export type FieldSource = "contact" | "profile" | "manual" | "perSend" | "static";
export interface FieldConfig { source: FieldSource; field?: string; value?: string; allowEmpty?: boolean }
export type PlaceholderConfig = Record<string, FieldConfig>;

export const CONTACT_FIELDS = ["Name", "firstName", "Company", "Role", "Email", "Link"] as const;
export const PROFILE_FIELDS = [
  "SENDER_NAME", "SENDER_EMAIL", "CONTACT_NO", "RESUME_LINK", "LINKEDIN_LINK", "HEADLINE", "SKILLS_SUMMARY",
] as const;

export const BUILTIN_PLACEHOLDERS: PlaceholderConfig = {
  ...Object.fromEntries(CONTACT_FIELDS.map((f) => [f, { source: "contact", field: f }])),
  ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f, { source: "profile", field: f }])),
};

export type ContactValues = { Name: string; Company: string; Email: string; Role: string; Link: string | null };
export type ProfileValues = Record<(typeof PROFILE_FIELDS)[number], string>;

export const firstNameOf = (name: string) => name.split(/\s+/).find(Boolean) ?? "";

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function tokensIn(...texts: string[]): string[] {
  const s = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(TOKEN_RE)) s.add(m[1]);
  return [...s];
}

export const configFor = (key: string, cfg: PlaceholderConfig): FieldConfig | undefined =>
  Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : BUILTIN_PLACEHOLDERS[key];

export interface TemplateInput { subject: string; html: string; placeholderConfig: PlaceholderConfig }

/**
 * Values that do not depend on the recipient. Precedence is decided per placeholder by its configured source:
 * a template's own config overrides the built-in default; perSend values only apply to perSend fields.
 */
export function resolveGlobals(t: TemplateInput, profile: ProfileValues, perSend: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of tokensIn(t.subject, t.html)) {
    const cfg = configFor(key, t.placeholderConfig);
    if (!cfg || cfg.source === "contact") continue;
    const v = cfg.source === "profile" ? profile[cfg.field as keyof ProfileValues] ?? ""
      : cfg.source === "perSend" ? perSend[key] ?? ""
      : cfg.value ?? "";
    out[key] = v.trim();
  }
  return out;
}

export interface Rendered { subject: string; html: string; unresolved: string[]; unknown: string[] }

function contactValue(field: string | undefined, c: ContactValues): string {
  switch (field) {
    case "Name": return c.Name;
    case "firstName": return firstNameOf(c.Name);
    case "Company": return c.Company;
    case "Role": return c.Role;
    case "Email": return c.Email;
    case "Link": return c.Link ?? "";
    default: return "";
  }
}

/** Single pass: substituted values are never re-scanned for tokens. HTML values are escaped; subject is plain text. */
export function renderForContact(t: TemplateInput, c: ContactValues, globals: Record<string, string>): Rendered {
  const unresolved = new Set<string>();
  const unknown = new Set<string>();
  const valueOf = (key: string): string | null => {
    const cfg = configFor(key, t.placeholderConfig);
    if (!cfg) { unknown.add(key); return null; }
    const v = cfg.source === "contact" ? contactValue(cfg.field ?? key, c).trim() : globals[key] ?? "";
    if (!v && !cfg.allowEmpty) unresolved.add(key);
    return v;
  };
  const subject = t.subject
    .replace(TOKEN_RE, (m, k: string) => valueOf(k) ?? m)
    .replace(/[\r\n]+/g, " ")
    .trim();
  const html = sanitizeEmailHtml(t.html.replace(TOKEN_RE, (m, k: string) => {
    const v = valueOf(k);
    return v === null ? m : escapeHtml(v);
  }));
  return { subject, html, unresolved: [...unresolved], unknown: [...unknown] };
}
