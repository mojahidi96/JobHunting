// Mirrors ../../API_CONTRACT.md. Change the contract first.
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

export interface HealthResponse { status: "ok"; service: string }
export interface RecruitersResponse {
  items: Recruiter[];
  source: { fileName: string; sheetName: string };
  warnings: string[];
}
export interface PreviewRequest { recruiterIds: string[]; template: EmailTemplate }
export interface PreviewItem { recruiterId: string; to: string; subject: string; html: string; warnings: string[] }
export interface PreviewResponse { items: PreviewItem[] }
export interface SendRequest {
  recruiterIds: string[];
  template: EmailTemplate;
  options: { delayMinMs: number; delayMaxMs: number; skipRowsMarkedNo: boolean };
  confirmation: true;
}
export interface SendResponse { jobId: string; status: JobStatus; total: number; message: string }
export interface JobResult { recruiterId: string; email: string; status: DeliveryStatus; error?: string }
export interface JobResponse {
  jobId: string;
  status: JobStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  results: JobResult[];
}
export interface ApiErrorBody { error: { code: string; message: string; details?: unknown[] } }

export const PLACEHOLDERS = [
  ["Name", "Full name from the sheet"],
  ["firstName", "First word of Name"],
  ["Company", "Company"],
  ["Role", "Role"],
  ["Email", "Recipient email"],
  ["Link", "Link column (empty if missing)"],
  ["SENDER_NAME", "Your name (server config)"],
  ["SENDER_EMAIL", "Your email (server config)"],
  ["CONTACT_NO", "Your phone (server config)"],
  ["RESUME_LINK", "Resume URL (server config)"],
  ["LINKEDIN_LINK", "LinkedIn URL (server config)"],
] as const;
