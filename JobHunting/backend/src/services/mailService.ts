import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config/env.js";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close(): void;
}

/** Pooled Gmail transporter, created on first use. `from` is always fixed server-side. */
export function createGmailMailer(config: Pick<Config, "senderName" | "senderEmail" | "senderPass">): Mailer {
  let transporter: Transporter | null = null;
  const get = () =>
    (transporter ??= nodemailer.createTransport({
      pool: true,
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: config.senderEmail, pass: config.senderPass },
    }));
  return {
    async send(m) {
      await get().sendMail({
        from: `${config.senderName.replace(/[<>"\r\n]/g, "")} <${config.senderEmail}>`,
        to: m.to,
        subject: m.subject,
        html: m.html,
      });
    },
    close() {
      transporter?.close();
      transporter = null;
    },
  };
}

/** Maps SMTP errors to a short message that never contains credentials or server details. */
export function safeSmtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number } | undefined;
  if (e?.code === "EAUTH" || e?.responseCode === 535) return "SMTP authentication failed. Check SENDER_EMAIL and the Gmail App Password.";
  if (e?.code === "EENVELOPE" || e?.responseCode === 550 || e?.responseCode === 553) return "The recipient address was rejected.";
  if (e?.code === "ETIMEDOUT" || e?.code === "ECONNECTION" || e?.code === "ESOCKET" || e?.code === "ECONNREFUSED") return "Could not connect to the SMTP server.";
  return "The email could not be sent.";
}
