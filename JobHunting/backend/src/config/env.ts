import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface Config {
  port: number;
  corsOrigins: string[];
  excelPath: string | null;
  sheetName: string;
  senderName: string;
  senderEmail: string;
  senderPass: string;
  contactNo: string;
  resumeLink: string;
  linkedinLink: string;
}

export const MIN_DELAY_BOUND_MS = 30_000;
export const MAX_DELAY_BOUND_MS = 300_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const excel = env.EXCEL_PATH?.trim();
  return {
    port: Number(env.PORT) || 4000,
    corsOrigins: (env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    excelPath: excel ? path.resolve(excel) : null,
    sheetName: env.SHEET_NAME?.trim() || "Recruiters_Email",
    senderName: env.SENDER_NAME?.trim() ?? "",
    senderEmail: env.SENDER_EMAIL?.trim() ?? "",
    senderPass: env.SENDER_PASS ?? "",
    contactNo: env.CONTACT_NO?.trim() ?? "",
    resumeLink: env.RESUME_LINK?.trim() ?? "",
    linkedinLink: env.LINKEDIN_LINK?.trim() ?? "",
  };
}

/** Names (never values) of env vars that are not set. */
export function missingEnv(config: Config): string[] {
  const m: string[] = [];
  if (!config.excelPath) m.push("EXCEL_PATH");
  if (!config.senderName) m.push("SENDER_NAME");
  if (!config.senderEmail) m.push("SENDER_EMAIL");
  if (!config.senderPass) m.push("SENDER_PASS");
  return m;
}
