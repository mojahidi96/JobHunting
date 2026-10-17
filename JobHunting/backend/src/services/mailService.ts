import nodemailer, { type Transporter } from "nodemailer";

export interface SenderCredentials { senderName: string; senderEmail: string; password: string }
export interface MailMessage { to: string; subject: string; html: string }
export interface MailResult { messageId: string | null }

export interface Mailer {
  verify(): Promise<void>;
  send(message: MailMessage): Promise<MailResult>;
  close(): void;
}
export type MailerFactory = (c: SenderCredentials) => Mailer;

/** Gmail SMTP (smtp.gmail.com:465, TLS). `from` is always built from the stored, verified identity. */
export const gmailMailerFactory: MailerFactory = (c) => {
  let transporter: Transporter | null = null;
  const get = () =>
    (transporter ??= nodemailer.createTransport({
      pool: true, host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: c.senderEmail, pass: c.password },
      connectionTimeout: 15_000, socketTimeout: 30_000,
    }));
  return {
    async verify() { await get().verify(); },
    async send(m) {
      const info = await get().sendMail({
        from: { name: c.senderName.replace(/[<>"\r\n]/g, ""), address: c.senderEmail },
        to: m.to, subject: m.subject, html: m.html,
      });
      return { messageId: info.messageId ?? null };
    },
    close() { transporter?.close(); transporter = null; },
  };
};

export interface SafeSendError { code: string; message: string; retryable: boolean }

/**
 * Maps provider errors to a short message with no credentials or server details.
 * `retryable` is only true when the provider definitely did not accept the message.
 */
export function safeSendError(err: unknown): SafeSendError {
  const e = err as { code?: string; responseCode?: number; command?: string } | undefined;
  if (e?.code === "EAUTH" || e?.responseCode === 535)
    return { code: "AUTH_FAILED", message: "Sender authentication failed. Re-check your app password in Email Sending Settings.", retryable: false };
  if (e?.code === "EENVELOPE" || e?.responseCode === 550 || e?.responseCode === 553 || e?.responseCode === 501)
    return { code: "RECIPIENT_REJECTED", message: "The recipient address was rejected by the provider.", retryable: false };
  if (e?.responseCode === 421 || e?.responseCode === 450 || e?.responseCode === 451 || e?.responseCode === 452)
    return { code: "TEMPORARY_FAILURE", message: "The provider reported a temporary failure.", retryable: true };
  if (e?.code === "ECONNECTION" || e?.code === "ECONNREFUSED" || e?.code === "DNS" || e?.code === "EDNS")
    return { code: "CONNECTION_FAILED", message: "Could not connect to the mail server. The message was not sent.", retryable: true };
  // Timeouts/socket errors may happen after the provider accepted the message: outcome is uncertain, never auto-retried.
  if (e?.code === "ETIMEDOUT" || e?.code === "ESOCKET")
    return { code: "OUTCOME_UNKNOWN", message: "The connection dropped; the message may or may not have been accepted. Check your Sent folder before retrying.", retryable: false };
  return { code: "SEND_FAILED", message: "The email could not be sent.", retryable: false };
}
