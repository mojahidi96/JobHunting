import type { Types } from "mongoose";
import type { Config } from "../config/env.js";
import { decryptSecret } from "../lib/crypto.js";
import { EmailHistory, EmailJob, RecruiterContact, User } from "../models/index.js";
import { safeSendError, type Mailer, type MailerFactory } from "./mailService.js";
import { renderForContact, type PlaceholderConfig } from "./templateEngine.js";

interface Deps {
  config: Config;
  mailerFactory: MailerFactory;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Durable, sequential job runner. All state lives in MongoDB; the in-process loop only drives it.
 * At most one job per user is active (enforced by a partial unique index), so the same sender never overlaps.
 */
export class JobRunner {
  private running = new Set<Promise<void>>();
  private abort = new AbortController();
  private sleep: NonNullable<Deps["sleep"]>;
  private random: () => number;

  constructor(private deps: Deps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
  }

  start(jobId: string) {
    const p = this.run(jobId).catch((e) => {
      console.error(`[job ${jobId}] runner error:`, e instanceof Error ? e.message : "unknown");
    }).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  async idle() { await Promise.all([...this.running]); }

  /** Graceful shutdown: stop starting new sends, let the in-flight send finish, then record what was interrupted. */
  async stop() {
    this.abort.abort();
    await this.idle();
  }

  private async run(jobId: string) {
    const job = await EmailJob.findById(jobId);
    if (!job || !job.active) return;
    await EmailJob.updateOne({ _id: job._id }, { $set: { status: "running", startedAt: new Date() } });

    const user = await User.findById(job.userId).select("+emailIdentity.credential");
    const idn = user?.emailIdentity;
    if (!user || !idn?.credential?.data || idn.status !== "verified" || idn.senderEmail !== job.sender?.senderEmail) {
      await this.interrupt(job._id, "SENDER_UNAVAILABLE", "The verified sender identity is no longer available.", true);
      return;
    }
    let mailer: Mailer | null = null;
    try {
      mailer = this.deps.mailerFactory({
        provider: idn.provider ?? "gmail_oauth", senderName: idn.senderName ?? "", senderEmail: idn.senderEmail,
        secret: decryptSecret(idn.credential as any, this.deps.config.encryptionKey),
      });
      const tpl = { subject: job.templateSnapshot!.subject!, html: job.templateSnapshot!.html!, placeholderConfig: (job.templateSnapshot!.placeholderConfig ?? {}) as PlaceholderConfig };
      const globals = Object.fromEntries(job.globals ?? []) as Record<string, string>;

      for (;;) {
        if (this.abort.signal.aborted) break;
        // Atomically claim the next pending recipient; a recipient is never attempted twice.
        const h = await EmailHistory.findOneAndUpdate(
          { jobId: job._id, userId: job.userId, status: "pending", attemptStartedAt: null },
          { $set: { attemptStartedAt: new Date() } },
          { sort: { _id: 1 }, returnDocument: "after" },
        );
        if (!h) break;

        const rendered = renderForContact(tpl, { Name: h.snapshot!.Name!, Company: h.snapshot!.Company!, Email: h.snapshot!.Email!, Role: h.snapshot!.Role!, Link: h.snapshot!.Link ?? null }, globals);
        let fatalAuth = false;
        try {
          const res = await mailer.send({ to: h.snapshot!.Email!, subject: rendered.subject, html: rendered.html });
          // "sent" = accepted by the provider (SMTP server or Gmail API), not guaranteed inbox delivery.
          const at = new Date();
          await EmailHistory.updateOne({ _id: h._id }, { $set: { status: "sent", completedAt: at, providerMessageId: res.messageId ?? undefined, subject: rendered.subject } });
          await EmailJob.updateOne({ _id: job._id }, { $inc: { "totals.sent": 1 } });
          await RecruiterContact.updateOne({ _id: h.contactId, userId: job.userId }, { $set: { lastDelivery: { status: "sent", at, jobId: job._id } } });
        } catch (err) {
          const safe = safeSendError(err);
          const at = new Date();
          await EmailHistory.updateOne({ _id: h._id }, { $set: { status: "failed", completedAt: at, error: safe } });
          await EmailJob.updateOne({ _id: job._id }, { $inc: { "totals.failed": 1 } });
          await RecruiterContact.updateOne({ _id: h.contactId, userId: job.userId }, { $set: { lastDelivery: { status: "failed", at, jobId: job._id, error: safe.message } } });
          console.error(`[job ${job._id}] send failed (${safe.code})`);
          // Quota exhausted: every further attempt would fail too, so stop here and leave the rest retryable.
          if (safe.code === "QUOTA_EXCEEDED") fatalAuth = true;
          if (safe.code === "AUTH_FAILED") {
            fatalAuth = true;
            await User.updateOne({ _id: job.userId }, { $set: { "emailIdentity.status": "failed", "emailIdentity.verifiedAt": null, "emailIdentity.lastError": safe.message } });
          }
        }
        if (fatalAuth) break;

        const more = await EmailHistory.exists({ jobId: job._id, status: "pending", attemptStartedAt: null });
        if (!more || this.abort.signal.aborted) continue;
        await this.sleep(job.options!.delayMinMs! + this.random() * (job.options!.delayMaxMs! - job.options!.delayMinMs!), this.abort.signal);
      }
    } finally {
      mailer?.close();
    }
    await this.interrupt(job._id, "JOB_ABORTED", "The job stopped before this recipient was attempted. It can be retried.", true);
  }

  /** Marks any never-attempted recipients as failed (retryable) and finalises the job. */
  private async interrupt(jobId: Types.ObjectId, code: string, message: string, retryable: boolean) {
    await finalizeJob(jobId, { code, message, retryable });
  }
}

/**
 * Closes a job: recipients never attempted -> failed (retryable); recipients attempted but with no recorded outcome
 * (crash mid-send) -> failed with OUTCOME_UNKNOWN (not retryable: the provider may have accepted them).
 */
export async function finalizeJob(jobId: Types.ObjectId | string, notAttempted: { code: string; message: string; retryable: boolean }) {
  const now = new Date();
  const a = await EmailHistory.updateMany({ jobId, status: "pending", attemptStartedAt: null }, { $set: { status: "failed", completedAt: now, error: notAttempted } });
  const b = await EmailHistory.updateMany(
    { jobId, status: "pending", attemptStartedAt: { $ne: null } },
    { $set: { status: "failed", completedAt: now, error: { code: "OUTCOME_UNKNOWN", message: "The server stopped while sending; this message may have been accepted. Check your Sent folder before retrying.", retryable: false } } },
  );
  const extra = a.modifiedCount + b.modifiedCount;
  if (extra) await EmailJob.updateOne({ _id: jobId }, { $inc: { "totals.failed": extra } });
  const job = await EmailJob.findById(jobId);
  if (!job) return;
  const { sent, failed } = job.totals!;
  const status = !failed ? "completed" : !sent ? "failed" : "completed_with_errors";
  await EmailJob.updateOne({ _id: jobId }, { $set: { status, active: false, finishedAt: now } });
}

/** On boot: any job still marked active belongs to a process that died. */
export async function recoverInterruptedJobs() {
  const jobs = await EmailJob.find({ active: true }).select("_id").lean();
  for (const j of jobs) {
    await finalizeJob(j._id, { code: "INTERRUPTED", message: "The server restarted before this recipient was attempted. It can be retried.", retryable: true });
  }
  return jobs.length;
}
