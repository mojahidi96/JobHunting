import type { Types } from "mongoose";
import type { Config } from "../config/env.js";
import { User } from "../models/index.js";
import { audit } from "./auditService.js";

/**
 * Trusted server-side owner bootstrap. Grants Admin + owner to the account whose email equals OWNER_EMAIL, but only once that
 * email is *verified* (Google or an emailed code). A password sign-up with the owner's address, which proves nothing, gets no
 * privileges; and public registration can never set `role`/`isOwner` (the request schema is strict).
 */
export async function ensureOwner(config: Config, userId?: Types.ObjectId): Promise<boolean> {
  if (!config.ownerEmail) return false;
  const filter: Record<string, unknown> = { email: config.ownerEmail, emailVerified: true };
  if (userId) filter._id = userId;
  const owner = await User.findOne(filter).select("role isOwner email");
  if (!owner || (owner.role === "admin" && owner.isOwner)) return false;
  await User.updateOne({ _id: owner._id }, { $set: { role: "admin", isOwner: true, status: "active", suspendedAt: null } });
  await audit({ action: "owner.bootstrap", target: { id: owner._id, email: owner.email } });
  return true;
}

/** Startup migration: backfill role/status on pre-existing accounts, demote any stray owner flag, then bootstrap the owner. */
export async function initAuthorization(config: Config) {
  await User.updateMany({ role: { $exists: false } }, { $set: { role: "candidate" } });
  await User.updateMany({ status: { $exists: false } }, { $set: { status: "active" } });
  await User.updateMany({ isOwner: { $exists: false } }, { $set: { isOwner: false } });
  // Only the configured owner address may carry the owner flag.
  await User.updateMany({ isOwner: true, email: { $ne: config.ownerEmail ?? "" } }, { $set: { isOwner: false } });
  const granted = await ensureOwner(config);
  if (!config.ownerEmail) console.warn("OWNER_EMAIL is not set: no one can administer the app until it is configured.");
  return granted;
}
