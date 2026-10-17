import nodemailer from "nodemailer";
import type { Config } from "../config/env.js";

/** Sends login codes. Uses the app's own transactional SMTP, never a user's outreach credentials. */
export interface AuthMailer {
  sendOtp(to: string, code: string, ttlMinutes: number): Promise<void>;
  close(): void;
}

export function createAuthMailer(smtp: NonNullable<Config["authSmtp"]>): AuthMailer {
  const transporter = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15_000, socketTimeout: 30_000,
  });
  return {
    async sendOtp(to, code, ttlMinutes) {
      await transporter.sendMail({
        from: smtp.from, to,
        subject: `Your JobHunting sign-in code: ${code}`,
        text: `Your JobHunting sign-in code is ${code}.\n\nIt expires in ${ttlMinutes} minutes and can be used once. If you didn't request it, you can ignore this email.`,
        html: `<p>Your JobHunting sign-in code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>It expires in ${ttlMinutes} minutes and can be used once. If you didn't request it, you can ignore this email.</p>`,
      });
    },
    close() { transporter.close(); },
  };
}
