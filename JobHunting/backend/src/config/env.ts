import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  corsOrigins: string[];
  mongoUri: string;
  /** 32-byte key used for AES-256-GCM encryption of sender credentials. */
  encryptionKey: Buffer;
  /** Server-side session policy: inactivity window (sliding) and absolute maximum lifetime. */
  sessionIdleDays: number;
  sessionMaxDays: number;
  /** Where the browser is sent after Google sign-in (the UI origin). */
  frontendUrl: string;
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  /** Dedicated transactional SMTP for login OTPs, separate from users' outreach credentials. */
  authSmtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string } | null;
  /** Allow the Gmail App Password sender (collects a mailbox-wide credential). Off by default in production. */
  allowAppPassword: boolean;
  cookieSecure: boolean;
  uploadDir: string;
  /** Hard bounds applied to any client-supplied delay (ms). */
  minDelayBoundMs: number;
  maxDelayBoundMs: number;
  defaultDelayMinMs: number;
  defaultDelayMaxMs: number;
  /** Disable rate limits only in tests. */
  rateLimits: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development") as Config["env"];
  const mongoUri = env.MONGODB_URI?.trim() ?? "";
  if (!mongoUri) throw new ConfigError("MONGODB_URI is not set. Copy backend/.env.example to backend/.env and fill it in.");

  const keyB64 = env.ENCRYPTION_KEY?.trim() ?? "";
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new ConfigError('ENCRYPTION_KEY must be 32 random bytes, base64 encoded (generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").');
  }

  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  const corsOrigins = (env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);
  if (nodeEnv === "production" && corsOrigins.some((o) => !o.startsWith("https://"))) {
    throw new ConfigError("In production CORS_ORIGIN must contain https:// origins only.");
  }
  return {
    env: nodeEnv,
    port: num(env.PORT, 4000),
    corsOrigins,
    mongoUri,
    encryptionKey: key,
    sessionIdleDays: num(env.SESSION_IDLE_DAYS, 7),
    sessionMaxDays: num(env.SESSION_MAX_DAYS ?? env.SESSION_TTL_DAYS, 7),
    frontendUrl: (env.FRONTEND_URL?.trim() || corsOrigins[0] || "http://localhost:5173").replace(/\/$/, ""),
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
      ? { clientId: env.GOOGLE_CLIENT_ID.trim(), clientSecret: env.GOOGLE_CLIENT_SECRET.trim(), redirectUri: env.GOOGLE_REDIRECT_URI.trim() }
      : null,
    authSmtp: env.AUTH_SMTP_HOST && env.AUTH_SMTP_USER && env.AUTH_SMTP_PASS && env.AUTH_SMTP_FROM
      ? {
        host: env.AUTH_SMTP_HOST.trim(), port: num(env.AUTH_SMTP_PORT, 465), secure: (env.AUTH_SMTP_SECURE ?? "true") !== "false",
        user: env.AUTH_SMTP_USER.trim(), pass: env.AUTH_SMTP_PASS, from: env.AUTH_SMTP_FROM.trim(),
      }
      : null,
    allowAppPassword: env.ENABLE_APP_PASSWORD_SENDER ? env.ENABLE_APP_PASSWORD_SENDER === "true" : nodeEnv !== "production",
    cookieSecure: nodeEnv === "production" || env.COOKIE_SECURE === "true",
    uploadDir: path.resolve(env.UPLOAD_DIR?.trim() || "./uploads"),
    minDelayBoundMs: num(env.MIN_DELAY_BOUND_MS, 30_000),
    maxDelayBoundMs: num(env.MAX_DELAY_BOUND_MS, 300_000),
    defaultDelayMinMs: num(env.DEFAULT_DELAY_MIN_MS, 45_000),
    defaultDelayMaxMs: num(env.DEFAULT_DELAY_MAX_MS, 90_000),
    rateLimits: nodeEnv !== "test",
  };
}
