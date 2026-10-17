import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Types } from "mongoose";
import { ApiError } from "../errors.js";
import { safeEqual, sha256 } from "../lib/crypto.js";
import { Session, User } from "../models/index.js";
import type { Config } from "../config/env.js";

export const SESSION_COOKIE = "jh_session";

export interface AuthContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  csrfToken: string;
  expiresAt: Date;
  lastActiveAt: Date;
}
declare module "express-serve-static-core" {
  interface Request { auth?: AuthContext }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Session cookie (HttpOnly) -> req.auth, with server-controlled expiry:
 *  - absolute maximum lifetime (`expiresAt`, never extended), and
 *  - inactivity expiry: `lastActiveAt` must be within `sessionIdleDays`.
 * Requests flagged `X-Background: 1` (polling) are authenticated but do NOT count as activity,
 * so an idle tab cannot keep a session alive.
 * For state-changing methods it additionally requires an allowed Origin and a matching X-CSRF-Token.
 */
export function requireAuth(config: Config): RequestHandler {
  const idleMs = config.sessionIdleDays * 86_400_000;
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || !token) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
    const session = await Session.findOne({ tokenHash: sha256(token) }).lean();
    if (!session) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");

    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.lastActiveAt.getTime() + idleMs <= now) {
      await Session.deleteOne({ _id: session._id });
      throw new ApiError(401, "SESSION_EXPIRED", "Your session expired. Please sign in again.");
    }

    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.get("origin");
      if (origin && !config.corsOrigins.includes(origin)) throw new ApiError(403, "FORBIDDEN_ORIGIN", "Request origin is not allowed.");
      const header = req.get("x-csrf-token") ?? "";
      if (!header || !safeEqual(header, session.csrfToken)) throw new ApiError(403, "CSRF_INVALID", "Missing or invalid CSRF token.");
    }

    let lastActiveAt = session.lastActiveAt;
    if (req.get("x-background") !== "1" && now - session.lastActiveAt.getTime() > TOUCH_INTERVAL_MS) {
      lastActiveAt = new Date(now);
      await Session.updateOne({ _id: session._id }, { $set: { lastActiveAt } });
    }
    req.auth = { userId: session.userId, sessionId: session._id, csrfToken: session.csrfToken, expiresAt: session.expiresAt, lastActiveAt };
    next();
  };
}

/** Loads the signed-in user (without password hash / credential). */
export async function currentUser(req: Request) {
  const user = await User.findById(req.auth!.userId);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
  return user;
}
