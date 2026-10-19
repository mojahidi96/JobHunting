import type { Types } from "mongoose";
import { AuditLog } from "../models/index.js";

export interface AuditEntry {
  actor?: { id: Types.ObjectId; email: string } | null;
  action: string;
  target?: { id: Types.ObjectId; email: string } | null;
  meta?: Record<string, unknown>;
}

/** Append-only record of role changes and sensitive admin actions. `meta` must never contain secrets. */
export async function audit(e: AuditEntry) {
  await AuditLog.create({
    actorId: e.actor?.id ?? null, actorEmail: e.actor?.email ?? "",
    action: e.action, targetId: e.target?.id ?? null, targetEmail: e.target?.email ?? "", meta: e.meta ?? {},
  });
}
