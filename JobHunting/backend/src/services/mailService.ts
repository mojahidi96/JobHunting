import nodemailer, { type Transporter } from "nodemailer";

export type SenderProvider = "gmail_oauth" | "gmail_smtp";
/** `secret` is the decrypted refresh token (gmail_oauth) or app password (gmail_smtp). Held in memory only. */
export interface SenderCredentials { provider: SenderProvider; senderName: string; senderEmail: string; secret: string }
export interface MailMessage { to: string; subject: string; html: string }
export interface MailResult { messageId: string | null }

export interface Mailer {
  verify(): Promise<void>;
  send(message: MailMessage): Promise<MailResult>;
  close(): void;
}
export type MailerFactory = (c: SenderCredentials) => Mailer;

/** Gmail SMTP (smtp.gmail.com:465, TLS) with an App Password. `from` is always built from the stored, verified identity. */
export function createSmtpMailer(c: SenderCredentials): Mailer {
  let transporter: Transporter | null = null;
  const get = () =>
    (transporter ??= nodemailer.createTransport({
      pool: true, host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: c.senderEmail, pass: c.secret },
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
}

type ProviderError = Error & { code?: string; responseCode?: number };
const providerError = (message: string, code: string, extra: Partial<ProviderError> = {}) => Object.assign(new Error(message), { code }, extra);

/**
 * Sends through the Gmail API (users.messages.send) with an OAuth access token that only has the gmail.send scope:
 * the app can send as the user but cannot read their mailbox. Gmail rewrites `From` to the authorised account.
 */
export function createGmailApiMailer(
  c: SenderCredentials,
  deps: { accessToken: (refreshToken: string) => Promise<string>; fetchFn?: typeof fetch },
): Mailer {
  const doFetch = deps.fetchFn ?? fetch;
  const mime = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const token = async () => {
    try { return await deps.accessToken(c.secret); }
    catch (e) {
      // invalid_grant = revoked/expired consent -> the user must reconnect.
      const msg = String((e as { message?: string })?.message ?? "");
      if (/invalid_grant|invalid_client|unauthorized_client|revoked|expired/i.test(msg) || (e as { response?: { status?: number } })?.response?.status === 400) {
        throw providerError("Google authorisation was revoked or expired", "EAUTH");
      }
      throw providerError("Could not reach Google", "ECONNECTION");
    }
  };
  return {
    async verify() { await token(); },
    async send(m) {
      const accessToken = await token();
      const built = await mime.sendMail({
        from: { name: c.senderName.replace(/[<>"\r\n]/g, ""), address: c.senderEmail },
        to: m.to, subject: m.subject, html: m.html,
      });
      const raw = (built.message as Buffer).toString("base64url");
      let res: Response;
      try {
        res = await doFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw }), signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        const cause = (e as { cause?: { code?: string } })?.cause?.code;
        // Failed before a connection existed -> definitely not sent. Anything else may have reached Google.
        if (cause === "ENOTFOUND" || cause === "ECONNREFUSED" || cause === "EAI_AGAIN") throw providerError("Could not connect to Gmail", "ECONNECTION");
        throw providerError("Connection to Gmail dropped", "ESOCKET");
      }
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        return { messageId: body.id ?? null };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; status?: string; message?: string } };
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
      if (res.status === 401) throw providerError("Gmail rejected the token", "EAUTH");
      if (res.status === 429 || /ratelimit|quota|limitexceeded/i.test(reason)) throw providerError("Gmail sending limit reached", "EQUOTA");
      if (res.status === 403 && /insufficient|forbidden|permission/i.test(reason)) throw providerError("Gmail permission missing", "EAUTH");
      if (res.status === 403 || res.status === 404) { console.error(`Gmail API refused the request (${res.status} ${reason}). Is the Gmail API enabled for this Google project?`); throw providerError("Gmail API unavailable", "ECONFIG"); }
      if (res.status === 400) throw providerError("Gmail rejected the message", "EENVELOPE");
      throw providerError("Gmail error", "ESOCKET"); // 5xx: Google may have processed it, so the outcome is unknown
    },
    close() { /* stateless */ },
  };
}

/** Chooses the sending backend from the user's connected provider. */
export function createMailerFactory(deps: { googleClient: { accessToken: (t: string) => Promise<string> } | null }): MailerFactory {
  return (c) => {
    if (c.provider === "gmail_smtp") return createSmtpMailer(c);
    if (!deps.googleClient) {
      const unavailable = async () => { throw providerError("Gmail sending is not configured on this server", "EAUTH"); };
      return { verify: unavailable, send: unavailable, close() {} };
    }
    return createGmailApiMailer(c, { accessToken: (t) => deps.googleClient!.accessToken(t) });
  };
}

export interface SafeSendError { code: string; message: string; retryable: boolean }

/**
 * Maps provider errors to a short message with no credentials or server details.
 * `retryable` is only true when the provider definitely did not accept the message.
 */
export function safeSendError(err: unknown): SafeSendError {
  const e = err as { code?: string; responseCode?: number; command?: string } | undefined;
  if (e?.code === "EAUTH" || e?.responseCode === 535)
    return { code: "AUTH_FAILED", message: "Sender authentication failed. Reconnect your sending account in Email Sending Settings.", retryable: false };
  if (e?.code === "EQUOTA")
    return { code: "QUOTA_EXCEEDED", message: "Gmail's sending limit was reached. Nothing was sent; try again later.", retryable: true };
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
