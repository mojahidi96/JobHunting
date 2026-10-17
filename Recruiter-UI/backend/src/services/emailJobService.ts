import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { MAX_DELAY_BOUND_MS, MIN_DELAY_BOUND_MS } from "../config/env.js";
import type { Config } from "../config/env.js";
import type { DeliveryStatus, EmailTemplate, JobResult, JobStatus, SendOptions } from "../types/index.js";
import { recipientProblems, renderEmail } from "./emailTemplateService.js";
import { safeSmtpError, type Mailer } from "./mailService.js";
import type { WorkbookRecruiter } from "./workbookService.js";

export interface Job {
  jobId: string;
  status: JobStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  results: JobResult[];
}

interface Deps {
  mailer: Mailer;
  getSender: () => Pick<Config, "senderName" | "senderEmail" | "contactNo" | "resumeLink" | "linkedinLink">;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_OPTIONS: SendOptions = { delayMinMs: 45_000, delayMaxMs: 90_000, skipRowsMarkedNo: true };

export function normalizeOptions(o: Partial<SendOptions> | undefined): SendOptions {
  const clamp = (n: number) => Math.min(MAX_DELAY_BOUND_MS, Math.max(MIN_DELAY_BOUND_MS, n));
  const min = clamp(o?.delayMinMs ?? DEFAULT_OPTIONS.delayMinMs);
  const max = Math.max(min, clamp(o?.delayMaxMs ?? DEFAULT_OPTIONS.delayMaxMs));
  return { delayMinMs: min, delayMaxMs: max, skipRowsMarkedNo: o?.skipRowsMarkedNo ?? true };
}

/** In-memory job registry. Job history and delivery status are lost on restart. */
export class EmailJobService {
  private jobs = new Map<string, Job>();
  private delivery = new Map<string, { status: DeliveryStatus; lastError?: string; sentAt?: string }>();
  private inFlight = new Set<string>();
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private running = new Set<Promise<void>>();

  constructor(private deps: Deps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
  }

  getJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "Job not found.");
    return job;
  }

  deliveryFor(recruiterId: string) {
    return this.delivery.get(recruiterId);
  }

  createJob(recruiters: WorkbookRecruiter[], template: EmailTemplate, rawOptions?: Partial<SendOptions>): Job {
    const options = normalizeOptions(rawOptions);
    const seenAddresses = new Set<string>();
    const results: JobResult[] = [];
    const eligible: WorkbookRecruiter[] = [];

    for (const r of recruiters) {
      const addr = r.Email.toLowerCase();
      const problems = recipientProblems(r);
      let skipReason: string | null = null;
      if (options.skipRowsMarkedNo && r.isSend?.toLowerCase() === "no") skipReason = "Row is marked isSend = no.";
      else if (problems.length) skipReason = problems[0] + ".";
      else if (seenAddresses.has(addr)) skipReason = "Duplicate address in this request.";
      if (skipReason) {
        results.push({ recruiterId: r.id, email: r.Email, status: "skipped", error: skipReason });
        continue;
      }
      seenAddresses.add(addr);
      results.push({ recruiterId: r.id, email: r.Email, status: "pending" });
      eligible.push(r);
    }

    const busy = eligible.filter((r) => this.inFlight.has(r.Email.toLowerCase()));
    if (busy.length) {
      throw new ApiError(409, "RECIPIENT_BUSY", "Another job is already sending to one or more of these recipients.", busy.map((r) => r.id));
    }
    for (const r of eligible) this.inFlight.add(r.Email.toLowerCase());

    const job: Job = {
      jobId: `job-${randomUUID()}`,
      status: "queued",
      total: results.length,
      sent: 0,
      failed: 0,
      skipped: results.filter((x) => x.status === "skipped").length,
      results,
    };
    this.jobs.set(job.jobId, job);
    for (const x of results) {
      if (x.status === "skipped") this.delivery.set(x.recruiterId, { status: "skipped", lastError: x.error });
    }

    const p = this.run(job, eligible, template, options).finally(() => this.running.delete(p));
    this.running.add(p);
    return job;
  }

  private async run(job: Job, eligible: WorkbookRecruiter[], template: EmailTemplate, o: SendOptions) {
    await new Promise<void>((r) => setImmediate(r)); // let the caller see "queued" first
    job.status = "running";
    try {
      for (let i = 0; i < eligible.length; i++) {
        const r = eligible[i];
        const res = job.results.find((x) => x.recruiterId === r.id)!;
        try {
          const email = renderEmail(r, template, this.deps.getSender());
          await this.deps.mailer.send({ to: email.to, subject: email.subject, html: email.html });
          res.status = "sent";
          job.sent++;
          this.delivery.set(r.id, { status: "sent", sentAt: new Date().toISOString() });
          console.log(`[job ${job.jobId}] sent to ${r.Email}`);
        } catch (err) {
          res.status = "failed";
          res.error = safeSmtpError(err);
          job.failed++;
          this.delivery.set(r.id, { status: "failed", lastError: res.error });
          console.error(`[job ${job.jobId}] failed for ${r.Email}: ${res.error}`);
        } finally {
          this.inFlight.delete(r.Email.toLowerCase());
        }
        if (i < eligible.length - 1) {
          await this.sleep(o.delayMinMs + this.random() * (o.delayMaxMs - o.delayMinMs));
        }
      }
      const attempted = job.sent + job.failed;
      job.status = job.failed === 0 ? "completed" : job.sent === 0 && attempted > 0 ? "failed" : "completed_with_errors";
    } catch {
      job.status = "failed";
    } finally {
      for (const r of eligible) this.inFlight.delete(r.Email.toLowerCase());
    }
  }

  /** Test helper / shutdown: resolves when all running jobs have finished. */
  async idle() {
    await Promise.all([...this.running]);
  }
}
