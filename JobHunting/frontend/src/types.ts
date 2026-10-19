// Mirrors docs/API_CONTRACT.md. Keep in sync with the backend DTO mappers (backend/src/lib/dto.ts).
export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";
export type JobStatus = "queued" | "running" | "completed" | "completed_with_errors" | "failed";
export type FieldSource = "contact" | "profile" | "manual" | "perSend" | "static";

export type Theme = "light" | "dark" | "system";
export interface User {
  id: string; name: string; email: string; profilePhotoUrl: string | null; templateOnboardingCompletedAt: string | null;
  onboardingCompleted: boolean; emailVerified: boolean; googleLinked: boolean; theme: Theme; createdAt: string;
  /** UI hint only. The server re-checks authorization on every request. */
  role: Role; isOwner: boolean;
}
export type Role = "admin" | "candidate";
export type AccountStatus = "active" | "suspended";
export interface AdminUser {
  id: string; name: string; email: string; role: Role; isOwner: boolean; status: AccountStatus; emailVerified: boolean; googleLinked: boolean;
  createdAt: string; lastLoginAt: string | null; suspendedAt: string | null;
}
export interface AdminUserDetail { user: AdminUser & { hasPassword: boolean; senderStatus: string; onboardingCompleted: boolean }; usage: { contacts: number; templates: number; jobs: number; emailsSent: number } }
export interface AuditItem { id: string; action: string; actorEmail: string | null; targetEmail: string | null; meta: Record<string, unknown>; createdAt: string }
export interface SmtpSettings {
  configured: boolean; source: "database" | "environment" | "none"; host: string; port: number; secure: boolean; user: string; from: string;
  hasPassword: boolean; updatedAt: string | null; lastTest: { ok: boolean; message: string; at: string } | null;
}
export interface Providers { password: boolean; google: boolean; otp: boolean }
export interface SignInResponse { user: User; csrfToken: string; isNewUser: boolean }
export interface Profile {
  name: string; loginEmail: string; profilePhotoUrl: string | null; theme: Theme; phone: string; headline: string; experienceYears: number | null;
  skillsSummary: string; resumeUrl: string; linkedinUrl: string; location: string; targetRoles: string; noticePeriod: string;
  createdAt: string; updatedAt: string;
}
export interface SenderSettings {
  provider: "gmail_oauth" | "gmail_smtp"; gmailOAuthAvailable?: boolean; appPasswordAllowed?: boolean; loginEmail: string; senderName: string; senderEmail: string;
  status: "not_configured" | "unverified" | "verified" | "failed"; verifiedAt: string | null; lastError: string | null; hasCredential: boolean;
}
export interface Contact {
  id: string; Name: string; Company: string; Email: string; Role: string; Link: string | null; isSend: "yes" | "no" | null;
  source: { type: "manual" | "import"; importId: string | null };
  deliveryStatus: DeliveryStatus; lastDelivery: { status: DeliveryStatus; at: string | null; error: string | null } | null;
  createdAt: string; updatedAt: string;
}
export interface ContactInput { Name: string; Company: string; Email: string; Role: string; Link: string | null; isSend: "yes" | "no" | null }
export interface ImportRecord {
  id: string; originalFilename: string; format: "xlsx" | "xls" | "json"; worksheetName: string | null;
  counts: { total: number; accepted: number; rejected: number; duplicates: number; skipped: number };
  errors: { row: number; messages: string[] }[]; storageRef: string; importedAt: string;
}
export interface ImportPreview {
  file: { name: string; format: string; worksheetName: string | null };
  headers: string[]; mapping: Record<string, string>; unknownColumns: string[]; missingRequired: string[];
  counts: ImportRecord["counts"]; truncated: boolean;
  rows: { row: number; status: "accepted" | "rejected" | "duplicate" | "skipped"; errors: string[]; contact: ContactInput | null }[];
}
export interface FieldConfig { source: FieldSource; field?: string; value?: string; allowEmpty?: boolean }
export type PlaceholderConfig = Record<string, FieldConfig>;
export interface Template {
  id: string; name: string; subject: string; html: string; placeholderConfig: PlaceholderConfig; version: number; isDefault: boolean;
  starterKey: string | null; reviewedVersion: number | null; reviewed: boolean; reviewedAt: string | null; createdAt: string; updatedAt: string;
}
export interface PreviewItem {
  contactId: string; to: string; name: string; company: string; status: "eligible" | "skipped"; skipReason: string | null;
  subject: string; html: string | null; warnings: string[]; previouslySentAt: string | null;
}
export interface PreviewResponse {
  sender: { provider: string; loginEmail: string; senderName: string; senderEmail: string; status: SenderSettings["status"] };
  template: { id: string | null; name: string | null; version: number | null; reviewed: boolean | null };
  summary: { selected: number; eligible: number; skipped: number };
  options: { delayMinMs: number; delayMaxMs: number; skipRowsMarkedNo: boolean };
  perSendFields: string[]; items: PreviewItem[];
  problems: { code: string; message: string; details: string[] }[]; canSend: boolean;
}
export interface Job {
  jobId: string; status: JobStatus; totals: { selected: number; sent: number; failed: number; skipped: number };
  sender: { provider: string; senderName: string; senderEmail: string }; template: { templateId: string; name: string; version: number } | null;
  retryOf: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface HistoryItem {
  id: string; jobId: string; contactId: string | null; recipient: { Name: string; Company: string; Email: string; Role: string };
  status: DeliveryStatus; subject: string | null; templateVersion: number | null;
  error: { code: string; message: string; retryable: boolean } | null; providerMessageId: string | null;
  retryOf: string | null; retried: boolean; createdAt: string; completedAt: string | null;
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
