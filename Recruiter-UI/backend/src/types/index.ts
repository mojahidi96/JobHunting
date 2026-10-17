export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";
export type JobStatus = "queued" | "running" | "completed" | "completed_with_errors" | "failed";

export interface Recruiter {
  id: string;
  rowNumber: number;
  Name: string;
  Company: string;
  Email: string;
  Role: string;
  Link: string | null;
  isSend: string | null;
  status: DeliveryStatus;
  lastError?: string;
  sentAt?: string;
}

export interface EmailTemplate {
  subject: string;
  html: string;
}

export interface SendOptions {
  delayMinMs: number;
  delayMaxMs: number;
  skipRowsMarkedNo: boolean;
}

export interface JobResult {
  recruiterId: string;
  email: string;
  status: DeliveryStatus;
  error?: string;
}
