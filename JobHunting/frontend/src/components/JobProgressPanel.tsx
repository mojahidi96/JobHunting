import type { JobResponse, Recruiter } from "../types/api";
import { StatusBadge } from "./StatusBadge";

const LABEL: Record<JobResponse["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
};

interface Props {
  job: JobResponse;
  recruiters: Map<string, Recruiter>;
  pollError: string | null;
}

export function JobProgressPanel({ job, recruiters, pollError }: Props) {
  const done = job.sent + job.failed + job.skipped;
  return (
    <section className="panel" aria-labelledby="job-h">
      <h2 id="job-h">Send job</h2>
      <p role="status">
        <strong>{LABEL[job.status]}</strong> — {done} of {job.total} processed · {job.sent} sent · {job.failed} failed · {job.skipped} skipped
      </p>
      <progress max={job.total || 1} value={done} aria-label="Job progress" />
      {pollError && <p className="error" role="alert">Could not refresh job status: {pollError}</p>}
      <ul className="results">
        {job.results.map((r) => (
          <li key={r.recruiterId}>
            <StatusBadge status={r.status} /> {recruiters.get(r.recruiterId)?.Name || r.email}{" "}
            <span className="muted">{r.email}</span>
            {r.error && <div className="small muted">{r.error}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
