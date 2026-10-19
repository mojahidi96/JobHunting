import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const opts = { timestamps: true, versionKey: false } as const;
const id = Schema.Types.ObjectId;

/* ------------------------------------------------------------------ users */
const encryptedSchema = new Schema({ iv: String, tag: String, data: String }, { _id: false });

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    // Optional: Google / OTP-only accounts have no password until they set one.
    passwordHash: { type: String, default: null, select: false },
    // True once ownership of `email` was proven (Google verified email or an email OTP).
    emailVerified: { type: Boolean, default: false },
    googleSub: { type: String, default: null },
    // Authorization. `role` is only ever changed server-side (owner bootstrap, admin API); never from client profile input.
    role: { type: String, enum: ["candidate", "admin"], default: "candidate" },
    // The application owner: the only account that may promote/demote admins. Set by trusted bootstrap only.
    isOwner: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    suspendedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    onboardingCompletedAt: { type: Date, default: null },
    theme: { type: String, enum: ["light", "dark", "system"], default: "system" },
    profilePhoto: {
      type: new Schema({ key: String, mime: String, updatedAt: Date }, { _id: false }),
      default: null,
    },
    profile: {
      phone: { type: String, default: "", maxlength: 40 },
      headline: { type: String, default: "", maxlength: 160 },
      experienceYears: { type: Number, default: null, min: 0, max: 70 },
      skillsSummary: { type: String, default: "", maxlength: 2000 },
      resumeUrl: { type: String, default: "", maxlength: 500 },
      linkedinUrl: { type: String, default: "", maxlength: 500 },
      location: { type: String, default: "", maxlength: 120 },
      targetRoles: { type: String, default: "", maxlength: 300 },
      noticePeriod: { type: String, default: "", maxlength: 120 },
    },
    // Sending identity is deliberately separate from the login email.
    emailIdentity: {
      // gmail_oauth: Google OAuth (gmail.send only), credential = encrypted refresh token.
      // gmail_smtp: Gmail App Password (opt-in), credential = encrypted app password.
      provider: { type: String, enum: ["gmail_oauth", "gmail_smtp"], default: "gmail_oauth" },
      senderName: { type: String, default: "", maxlength: 100 },
      senderEmail: { type: String, default: "", lowercase: true, maxlength: 254 },
      status: { type: String, enum: ["not_configured", "unverified", "verified", "failed"], default: "not_configured" },
      verifiedAt: { type: Date, default: null },
      lastError: { type: String, default: "" },
      credential: { type: encryptedSchema, default: null, select: false },
    },
    templateOnboardingCompletedAt: { type: Date, default: null },
  },
  opts,
);

userSchema.index({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: "string" } } });

/* --------------------------------------------------------------- sessions */
const sessionSchema = new Schema(
  {
    userId: { type: id, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    csrfToken: { type: String, required: true },
    method: { type: String, enum: ["password", "otp", "google"], default: "password" },
    // Absolute maximum lifetime (never extended) and sliding inactivity clock (server-controlled).
    expiresAt: { type: Date, required: true },
    lastActiveAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ------------------------------------------------- email OTP + OAuth state */
const otpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true },
    codeHash: { type: String, required: true }, // HMAC of the code; the code itself is never stored
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null }, // set on success, on resend (invalidation) or lockout
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
otpSchema.index({ email: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 }); // purge a day after expiry (kept for rate counting)

const oauthStateSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    state: { type: String, required: true },
    nonce: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    // "gmail" = connecting a sending account for the signed-in user (bound to userId); otherwise a sign-in.
    purpose: { type: String, enum: ["signin", "gmail"], default: "signin" },
    userId: { type: id, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ------------------------------------------------- audit log + app settings */
const auditSchema = new Schema(
  {
    actorId: { type: id, default: null },
    actorEmail: { type: String, default: "" },
    action: { type: String, required: true },
    targetId: { type: id, default: null },
    targetEmail: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed, default: {} }, // never secrets
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
auditSchema.index({ createdAt: -1 });

// Key/value application settings (e.g. the owner-configured transactional SMTP). Secrets are stored encrypted.
const appSettingSchema = new Schema(
  { key: { type: String, required: true, unique: true }, value: { type: Schema.Types.Mixed, default: {} }, lastTest: { type: Schema.Types.Mixed, default: null }, updatedBy: { type: id, default: null } },
  { timestamps: true, versionKey: false },
);

/* --------------------------------------------------------------- contacts */
const lastDeliverySchema = new Schema(
  { status: { type: String, enum: ["sent", "failed", "skipped"] }, at: Date, jobId: id, error: String },
  { _id: false },
);

const contactSchema = new Schema(
  {
    userId: { type: id, ref: "User", required: true },
    Name: { type: String, required: true, trim: true, maxlength: 200 },
    Company: { type: String, required: true, trim: true, maxlength: 200 },
    Email: { type: String, required: true, trim: true, maxlength: 254 },
    emailLower: { type: String, required: true },
    Role: { type: String, required: true, trim: true, maxlength: 200 },
    Link: { type: String, default: null, maxlength: 1000 },
    isSend: { type: String, enum: ["yes", "no", null], default: null },
    source: {
      type: { type: String, enum: ["manual", "import"], required: true },
      importId: { type: id, ref: "Import", default: null },
    },
    lastDelivery: { type: lastDeliverySchema, default: null },
  },
  opts,
);
contactSchema.index({ userId: 1, emailLower: 1 }, { unique: true });
contactSchema.index({ userId: 1, createdAt: -1 });
contactSchema.index({ userId: 1, "source.importId": 1 });

/* ---------------------------------------------------------------- imports */
const importSchema = new Schema(
  {
    userId: { type: id, ref: "User", required: true },
    originalFilename: { type: String, required: true, maxlength: 255 },
    format: { type: String, enum: ["xlsx", "xls", "json"], required: true },
    worksheetName: { type: String, default: null },
    mapping: { type: Map, of: String, default: {} },
    counts: {
      total: Number, accepted: Number, rejected: Number, duplicates: Number, skipped: Number,
    },
    rowErrors: [{ _id: false, row: Number, messages: [String] }],
    // Files are NOT retained. This is a logical reference only, never a filesystem path.
    storageRef: { type: String, required: true },
  },
  opts,
);
importSchema.index({ userId: 1, createdAt: -1 });

/* -------------------------------------------------------------- templates */
const templateSchema = new Schema(
  {
    userId: { type: id, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    subject: { type: String, required: true, maxlength: 300 },
    html: { type: String, required: true, maxlength: 100_000 },
    placeholderConfig: { type: Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1, min: 1 },
    isDefault: { type: Boolean, default: false },
    starterKey: { type: String, default: null },
    reviewedVersion: { type: Number, default: null },
    reviewedAt: { type: Date, default: null },
  },
  opts,
);
templateSchema.index({ userId: 1, name: 1 }, { unique: true });
templateSchema.index({ userId: 1, isDefault: 1 });

/* ------------------------------------------------------------------- jobs */
const jobSchema = new Schema(
  {
    userId: { type: id, ref: "User", required: true },
    status: { type: String, enum: ["queued", "running", "completed", "completed_with_errors", "failed"], default: "queued" },
    // true while queued/running. A partial unique index allows one active job per user.
    active: { type: Boolean, default: true },
    totals: {
      selected: { type: Number, default: 0 }, sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 }, skipped: { type: Number, default: 0 },
    },
    sender: { provider: String, senderName: String, senderEmail: String },
    template: { templateId: id, name: String, version: Number },
    // One copy of the (unpersonalised) template per job so retries re-render identically. No per-recipient bodies are stored.
    templateSnapshot: { subject: String, html: String, placeholderConfig: Schema.Types.Mixed },
    // Resolved profile/manual/per-send values at job creation (no credentials).
    globals: { type: Map, of: String, default: {} },
    options: { delayMinMs: Number, delayMaxMs: Number, skipRowsMarkedNo: Boolean },
    idempotencyKey: { type: String, required: true, maxlength: 100 },
    retryOf: { type: id, default: null },
    startedAt: Date,
    finishedAt: Date,
  },
  opts,
);
jobSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
jobSchema.index({ userId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
jobSchema.index({ userId: 1, createdAt: -1 });

/* ---------------------------------------------------------------- history */
const historySchema = new Schema(
  {
    userId: { type: id, ref: "User", required: true },
    jobId: { type: id, ref: "EmailJob", required: true },
    contactId: { type: id, default: null },
    snapshot: { Name: String, Company: String, Email: String, Role: String, Link: String },
    emailLower: { type: String, required: true },
    status: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending" },
    subject: String,
    templateVersion: Number,
    error: { code: String, message: String, retryable: Boolean },
    providerMessageId: String,
    attemptStartedAt: Date,
    completedAt: Date,
    retryOf: { type: id, default: null },
    retried: { type: Boolean, default: false },
  },
  opts,
);
historySchema.index({ userId: 1, createdAt: -1 });
historySchema.index({ userId: 1, status: 1, createdAt: -1 });
historySchema.index({ userId: 1, jobId: 1 });
historySchema.index({ userId: 1, emailLower: 1 });

function model<T extends Schema>(name: string, schema: T, collection: string) {
  return (mongoose.models[name] as Model<InferSchemaType<T>>) ?? mongoose.model<InferSchemaType<T>>(name, schema, collection);
}

export const User = model("User", userSchema, "users");
export const Session = model("Session", sessionSchema, "sessions");
export const OtpCode = model("OtpCode", otpSchema, "otpcodes");
export const AuditLog = model("AuditLog", auditSchema, "auditlogs");
export const AppSetting = model("AppSetting", appSettingSchema, "appsettings");
export const OAuthState = model("OAuthState", oauthStateSchema, "oauthstates");
export const RecruiterContact = model("RecruiterContact", contactSchema, "recruitercontacts");
export const ImportRecord = model("Import", importSchema, "imports");
export const EmailTemplate = model("EmailTemplate", templateSchema, "emailtemplates");
export const EmailJob = model("EmailJob", jobSchema, "emailjobs");
export const EmailHistory = model("EmailHistory", historySchema, "emailhistory");

export const allModels = [User, Session, OtpCode, OAuthState, RecruiterContact, ImportRecord, EmailTemplate, EmailJob, EmailHistory];
