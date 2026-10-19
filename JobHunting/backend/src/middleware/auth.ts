import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Types } from "mongoose";
import { ApiError } from "../errors.js";
import { safeEqual, sha256 } from "../lib/crypto.js";
import { Session, User } from "../models/index.js";
import type { Config } from "../config/env.js";

export const SESSION_COOKIE = "jh_session";
export const OAUTH_COOKIE = "jh_oauth"; // short-lived, binds an OAuth round trip to this browser

export interface AuthContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  csrfToken: string;
  expiresAt: Date;
  lastActiveAt: Date;
  /** Authorization is read from the database on every request, never from the client or the session cookie. */
  role: "candidate" | "admin";
  isOwner: boolean;
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

    const u = await User.findById(session.userId).select("role status isOwner emailVerified email").lean();
    if (!u) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
    if (u.status === "suspended") {
      await Session.deleteMany({ userId: session.userId });
      throw new ApiError(403, "ACCOUNT_SUSPENDED", "This account has been suspended. Contact the administrator.");
    }
    // Privileges require a verified email; owner status additionally requires the configured owner address.
    const isOwner = !!u.isOwner && !!u.emailVerified && !!config.ownerEmail && u.email === config.ownerEmail;
    const isAdmin = isOwner || (u.role === "admin" && !!u.emailVerified);

    let lastActiveAt = session.lastActiveAt;
    if (req.get("x-background") !== "1" && now - session.lastActiveAt.getTime() > TOUCH_INTERVAL_MS) {
      lastActiveAt = new Date(now);
      await Session.updateOne({ _id: session._id }, { $set: { lastActiveAt } });
    }
    req.auth = { userId: session.userId, sessionId: session._id, csrfToken: session.csrfToken, expiresAt: session.expiresAt, lastActiveAt, role: isAdmin ? "admin" : "candidate", isOwner };
    next();
  };
}

/** Deny by default: route-level guards, always layered after requireAuth. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.auth?.role !== "admin") throw new ApiError(403, "FORBIDDEN", "You don't have permission to do that.");
  next();
};
export const requireOwner: RequestHandler = (req, _res, next) => {
  if (!req.auth?.isOwner) throw new ApiError(403, "OWNER_ONLY", "Only the application owner can do that.");
  next();
};

/** Cookie-only session lookup for browser redirects (no CSRF/Origin checks; GET navigation). Returns null when not signed in. */
export async function sessionUserId(config: Config, req: Request): Promise<Types.ObjectId | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || !token) return null;
  const s = await Session.findOne({ tokenHash: sha256(token) }).lean();
  const now = Date.now();
  if (!s || s.expiresAt.getTime() <= now || s.lastActiveAt.getTime() + config.sessionIdleDays * 86_400_000 <= now) return null;
  return s.userId;
}

/** Loads the signed-in user (without password hash / credential). */
export async function currentUser(req: Request) {
  const user = await User.findById(req.auth!.userId);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
  return user;
}
