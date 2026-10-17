import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { EmailHistory, EmailJob } from "../src/models/index.js";
import { recoverInterruptedJobs } from "../src/services/jobRunner.js";
import { setup, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.teardown(); });

describe("restart recovery", () => {
  it("closes interrupted jobs: unattempted -> retryable, mid-send -> unknown outcome (not retryable)", async () => {
    const userId = new Types.ObjectId();
    const job = await EmailJob.create({ userId, status: "running", active: true, totals: { selected: 3, sent: 1, failed: 0, skipped: 0 }, idempotencyKey: "recovery-key-1" });
    const base = { userId, jobId: job._id, snapshot: { Name: "A", Company: "B", Email: "a@b.co", Role: "R" } };
    await EmailHistory.create([
      { ...base, emailLower: "sent@b.co", status: "sent", attemptStartedAt: new Date() },
      { ...base, emailLower: "mid@b.co", status: "pending", attemptStartedAt: new Date() },
      { ...base, emailLower: "never@b.co", status: "pending" },
    ]);
    expect(await recoverInterruptedJobs()).toBe(1);
    const rows = await EmailHistory.find({ jobId: job._id }).lean();
    const by = Object.fromEntries(rows.map((r) => [r.emailLower, r]));
    expect(by["mid@b.co"].error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    expect(by["never@b.co"].error).toMatchObject({ code: "INTERRUPTED", retryable: true });
    const done = await EmailJob.findById(job._id).lean();
    expect(done).toMatchObject({ active: false, status: "completed_with_errors" });
    expect(done!.totals).toMatchObject({ sent: 1, failed: 2 });
  });
});
