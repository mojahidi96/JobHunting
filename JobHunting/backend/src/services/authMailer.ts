import nodemailer from "nodemailer";
import type { Config } from "../config/env.js";
import { loadSmtp, type SmtpSettings } from "./emailSettings.js";

/** Sends the app's own transactional mail (login codes). Uses the app's verified sender, never a user's mailbox. */
export interface AuthMailer {
  sendOtp(to: string, code: string, ttlMinutes: number): Promise<void>;
  /** Optional: false when no delivery provider is configured (checked per request, so Admin changes apply immediately). */
  isConfigured?(): Promise<boolean>;
  close(): void;
}

export function buildTransport(smtp: SmtpSettings) {
  return nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15_000, socketTimeout: 30_000,
  });
}

export function otpMessage(from: string, to: string, code: string, ttlMinutes: number) {
  return {
    from, to,
    subject: `Your JobHunting sign-in code: ${code}`,
    text: `Your JobHunting sign-in code is ${code}.\n\nIt expires in ${ttlMinutes} minutes and can be used once. If you didn't request it, you can ignore this email.`,
    html: `<p>Your JobHunting sign-in code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>It expires in ${ttlMinutes} minutes and can be used once. If you didn't request it, you can ignore this email.</p>`,
  };
}

export function createAuthMailer(smtp: SmtpSettings): AuthMailer {
  const transporter = buildTransport(smtp);
  return {
    async sendOtp(to, code, ttlMinutes) { await transporter.sendMail(otpMessage(smtp.from, to, code, ttlMinutes)); },
    async isConfigured() { return true; },
    close() { transporter.close(); },
  };
}

/**
 * Resolves the delivery settings on every call: the owner's encrypted Admin setting first, then the AUTH_SMTP_* environment.
 * The transporter is cached per effective settings so saving new credentials takes effect without a restart.
 */
export function createConfiguredAuthMailer(config: Config): AuthMailer {
  let cached: { key: string; mailer: AuthMailer } | null = null;
  const current = async () => {
    const found = await loadSmtp(config);
    if (!found) return null;
    const key = JSON.stringify(found.smtp);
    if (cached?.key !== key) {
      cached?.mailer.close();
      cached = { key, mailer: createAuthMailer(found.smtp) };
    }
    return cached.mailer;
  };
  return {
    async isConfigured() { return !!(await current()); },
    async sendOtp(to, code, ttl) {
      const m = await current();
      if (!m) throw new Error("not configured");
      await m.sendOtp(to, code, ttl);
    },
    close() { cached?.mailer.close(); cached = null; },
  };
}
