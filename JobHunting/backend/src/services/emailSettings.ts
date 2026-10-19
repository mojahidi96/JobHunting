import type { Config } from "../config/env.js";
import { decryptSecret, encryptSecret, type Encrypted } from "../lib/crypto.js";
import { AppSetting } from "../models/index.js";

export interface SmtpSettings { host: string; port: number; secure: boolean; user: string; pass: string; from: string }
export type SmtpSource = "database" | "environment";

const KEY = "authSmtp";

/** Effective delivery settings: the owner's stored (encrypted) setting wins over the environment. */
export async function loadSmtp(config: Config): Promise<{ smtp: SmtpSettings; source: SmtpSource } | null> {
  const row = await AppSetting.findOne({ key: KEY }).lean();
  const v = row?.value as (Omit<SmtpSettings, "pass"> & { pass?: Encrypted }) | undefined;
  if (v?.host && v.user && v.from && v.pass) {
    try {
      return { smtp: { host: v.host, port: v.port, secure: v.secure, user: v.user, from: v.from, pass: decryptSecret(v.pass, config.encryptionKey) }, source: "database" };
    } catch {
      console.error("Stored email credential could not be decrypted (was ENCRYPTION_KEY changed?). Re-enter it in Admin settings.");
    }
  }
  return config.authSmtp ? { smtp: config.authSmtp, source: "environment" } : null;
}

export interface SmtpInput { host: string; port: number; secure: boolean; user: string; from: string; pass?: string }

export async function saveSmtp(config: Config, input: SmtpInput, adminId: unknown) {
  const row = await AppSetting.findOne({ key: KEY }).lean();
  const existingPass = (row?.value as { pass?: Encrypted } | undefined)?.pass;
  const pass = input.pass ? encryptSecret(input.pass, config.encryptionKey) : existingPass;
  if (!pass) return false; // a password is required the first time
  const value = { host: input.host, port: input.port, secure: input.secure, user: input.user, from: input.from, pass };
  await AppSetting.updateOne({ key: KEY }, { $set: { value, updatedBy: adminId } }, { upsert: true });
  return true;
}

export const clearSmtp = () => AppSetting.deleteOne({ key: KEY });

/** What the Admin UI may see. Never includes the password (only whether one is stored). */
export async function describeSmtp(config: Config) {
  const row = await AppSetting.findOne({ key: KEY }).lean();
  const found = await loadSmtp(config);
  return {
    configured: !!found,
    source: (found?.source ?? "none") as SmtpSource | "none",
    host: found?.smtp.host ?? "", port: found?.smtp.port ?? 465, secure: found?.smtp.secure ?? true,
    user: found?.smtp.user ?? "", from: found?.smtp.from ?? "",
    hasPassword: !!found, // a stored or environment password exists; its value is never returned
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    lastTest: row?.lastTest ?? null,
  };
}

/** Maps transport errors to a message that is safe to show: no host banners, usernames or credentials. */
export function safeMailError(e: unknown): { code: string; message: string } {
  const code = String((e as { code?: string })?.code ?? "");
  const resp = Number((e as { responseCode?: number })?.responseCode ?? 0);
  if (code === "EAUTH" || resp === 535 || resp === 534) return { code: "AUTH_FAILED", message: "The mail server rejected the username or password. For Gmail, use a 16-character App Password (2-Step Verification required), not the account password." };
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "ENOTFOUND", "EDNS"].includes(code)) return { code: "CONNECTION_FAILED", message: "Could not connect to the mail server. Check the host, port and TLS setting." };
  if (code === "EENVELOPE" || (resp >= 550 && resp < 560)) return { code: "REJECTED", message: "The mail server rejected the sender or recipient. Check that the From address is verified with your provider." };
  if (code === "ETLS" || code === "ECERT" || /certificate|ssl|tls/i.test(String((e as Error)?.message))) return { code: "TLS_FAILED", message: "A secure connection could not be established. Check the port and the TLS setting." };
  return { code: "SEND_FAILED", message: "The mail server returned an error." };
}

export async function recordTest(ok: boolean, message: string) {
  await AppSetting.updateOne({ key: KEY }, { $set: { lastTest: { ok, message, at: new Date().toISOString() } } }, { upsert: true });
}
