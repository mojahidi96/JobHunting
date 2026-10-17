import type { Types } from "mongoose";
import { ApiError } from "../errors.js";
import { User } from "../models/index.js";
import { createStarterTemplates } from "./authService.js";

export interface VerifiedIdentity {
  /** Ownership of this email was just proven (Google `email_verified`, or an email OTP). */
  email: string;
  name: string;
  googleSub?: string;
}

const nameFromEmail = (e: string) => e.split("@")[0].slice(0, 100) || "New user";

/**
 * Finds or creates the single user for a verified identity, linking sign-in methods safely.
 *  - A Google subject already linked wins.
 *  - An existing account is linked only because the email was *verified just now* — never from a bare matching string.
 *  - If that account's email was never verified (e.g. password sign-up), its password is removed: whoever pre-registered
 *    the address could otherwise keep access after the real owner proves ownership.
 *  - Concurrent first-time sign-ins race on the unique email / googleSub indexes; the loser re-reads the winner.
 */
export async function resolveVerifiedIdentity(id: VerifiedIdentity): Promise<{ userId: Types.ObjectId; isNew: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (id.googleSub) {
      const bySub = await User.findOne({ googleSub: id.googleSub }).select("_id");
      if (bySub) return { userId: bySub._id, isNew: false };
    }
    const existing = await User.findOne({ email: id.email }).select("+passwordHash");
    if (existing) {
      if (id.googleSub && existing.googleSub && existing.googleSub !== id.googleSub) {
        throw new ApiError(409, "GOOGLE_ACCOUNT_CONFLICT", "This email is already linked to a different Google account.");
      }
      const set: Record<string, unknown> = { emailVerified: true };
      if (id.googleSub) set.googleSub = id.googleSub;
      if (!existing.emailVerified) set.passwordHash = null;
      try {
        await User.updateOne({ _id: existing._id }, { $set: set });
      } catch (e: any) {
        if (e?.code === 11000) continue;
        throw e;
      }
      return { userId: existing._id, isNew: false };
    }
    try {
      const u = await User.create({ name: id.name.trim().slice(0, 100) || nameFromEmail(id.email), email: id.email, emailVerified: true, googleSub: id.googleSub ?? null });
      await createStarterTemplates(u._id);
      return { userId: u._id, isNew: true };
    } catch (e: any) {
      if (e?.code === 11000) continue; // someone else created it first; re-read on the next loop
      throw e;
    }
  }
  throw new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}
