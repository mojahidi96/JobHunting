import type { FieldConfig } from "./types";

export const CONTACT_FIELDS = ["Name", "firstName", "Company", "Role", "Email", "Link"] as const;
export const PROFILE_FIELDS = ["SENDER_NAME", "SENDER_EMAIL", "CONTACT_NO", "RESUME_LINK", "LINKEDIN_LINK", "HEADLINE", "SKILLS_SUMMARY"] as const;

export const BUILTIN: Record<string, FieldConfig> = {
  ...Object.fromEntries(CONTACT_FIELDS.map((f) => [f, { source: "contact", field: f } as FieldConfig])),
  ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f, { source: "profile", field: f } as FieldConfig])),
};

export const SOURCE_LABEL: Record<string, string> = {
  contact: "Contact field", profile: "My profile", manual: "Saved value", perSend: "Ask at send time", static: "Static text",
};

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
export const tokensIn = (...texts: string[]) => {
  const s = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(TOKEN_RE)) s.add(m[1]);
  return [...s];
};
