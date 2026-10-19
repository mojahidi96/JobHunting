import { createHmac, randomInt } from "node:crypto";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { safeEqual } from "../lib/crypto.js";
import { OtpCode } from "../models/index.js";
import type { AuthMailer } from "./authMailer.js";

export const OTP_TTL_MINUTES = 5;
export const OTP_RESEND_COOLDOWN_S = 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_HOUR = 5;

const hashCode = (config: Config, email: string, code: string) =>
  createHmac("sha256", config.encryptionKey).update(`otp:${email}:${code}`).digest("hex");

/** Generates, stores (hash only) and emails a code. Responds identically for every address (no account enumeration). */
export async function requestOtp(config: Config, mailer: AuthMailer | null, email: string) {
  if (!mailer || (mailer.isConfigured && !(await mailer.isConfigured()))) {
    // Operators see the real cause in the server log; users get the generic message (the Admin dashboard shows setup status).
    console.error("OTP unavailable: no email delivery provider is configured (Admin settings, or AUTH_SMTP_* in the environment).");
    throw new ApiError(503, "OTP_UNAVAILABLE", "Email sign-in codes are not available right now.");
  }
  const now = Date.now();
  const last = await OtpCode.findOne({ email }).sort({ createdAt: -1 }).lean();
  if (last) {
    const wait = Math.ceil((last.createdAt.getTime() + OTP_RESEND_COOLDOWN_S * 1000 - now) / 1000);
    if (wait > 0) throw new ApiError(429, "OTP_COOLDOWN", `Please wait ${wait}s before requesting another code.`, [], { retryAfterSeconds: wait });
  }
  const recent = await OtpCode.countDocuments({ email, createdAt: { $gt: new Date(now - 3_600_000) } });
  if (recent >= OTP_MAX_PER_HOUR) throw new ApiError(429, "OTP_RATE_LIMITED", "Too many codes requested. Try again later.", [], { retryAfterSeconds: 3600 });

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await OtpCode.updateMany({ email, consumedAt: null }, { $set: { consumedAt: new Date() } }); // resend invalidates older codes
  const doc = await OtpCode.create({ email, codeHash: hashCode(config, email, code), expiresAt: new Date(now + OTP_TTL_MINUTES * 60_000) });
  try {
    await mailer.sendOtp(email, code, OTP_TTL_MINUTES);
  } catch (e) {
    // Log the failure class only: never the recipient, the code or provider response text.
    console.error("OTP email delivery failed:", (e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown");
    await OtpCode.deleteOne({ _id: doc._id });
    throw new ApiError(502, "OTP_SEND_FAILED", "We couldn't send the code. Please try again shortly.");
  }
  return { expiresInSeconds: OTP_TTL_MINUTES * 60, resendAfterSeconds: OTP_RESEND_COOLDOWN_S };
}

/** Verifies and consumes a code (single use). Throws OTP_INVALID / OTP_EXPIRED / OTP_LOCKED. */
export async function verifyOtp(config: Config, email: string, code: string): Promise<void> {
  const active = await OtpCode.findOne({ email, consumedAt: null }).sort({ createdAt: -1 });
  if (!active) throw new ApiError(400, "OTP_INVALID", "That code is incorrect or no longer valid. Request a new one.");
  if (active.expiresAt.getTime() <= Date.now()) {
    await OtpCode.updateOne({ _id: active._id }, { $set: { consumedAt: new Date() } });
    throw new ApiError(400, "OTP_EXPIRED", "That code has expired. Request a new one.");
  }
  // Count the attempt atomically before comparing so parallel guesses cannot exceed the limit.
  const bumped = await OtpCode.findOneAndUpdate({ _id: active._id, consumedAt: null }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
  if (!bumped) throw new ApiError(400, "OTP_INVALID", "That code is incorrect or no longer valid. Request a new one.");
  if (bumped.attempts > OTP_MAX_ATTEMPTS) {
    await OtpCode.updateOne({ _id: bumped._id }, { $set: { consumedAt: new Date() } });
    throw new ApiError(429, "OTP_LOCKED", "Too many incorrect attempts. Request a new code.");
  }
  if (!safeEqual(bumped.codeHash, hashCode(config, email, code))) {
    throw new ApiError(400, "OTP_INVALID", "That code is incorrect. Check it and try again.", [], { attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - bumped.attempts) });
  }
  const used = await OtpCode.findOneAndUpdate({ _id: bumped._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!used) throw new ApiError(400, "OTP_INVALID", "That code is incorrect or no longer valid. Request a new one.");
}
