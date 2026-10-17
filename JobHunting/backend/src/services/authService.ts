import argon2 from "argon2";
import type { Types } from "mongoose";
import type { Response } from "express";
import type { Config } from "../config/env.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { EmailTemplate, Session } from "../models/index.js";
import { SESSION_COOKIE } from "../middleware/auth.js";
import { STARTERS } from "./starterTemplates.js";

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => argon2.hash(pw, ARGON_OPTS);

let dummyHash: Promise<string> | null = null;
/** Verifies against a dummy hash for unknown accounts so timing does not reveal whether an email exists. */
export async function verifyPassword(hash: string | null | undefined, pw: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword("dummy-password-for-timing");
    await argon2.verify(await dummyHash, pw).catch(() => false);
    return false;
  }
  return argon2.verify(hash, pw).catch(() => false);
}

export type SessionMethod = "password" | "otp" | "google";

/** Creates a server-side session. `expiresAt` is the absolute maximum lifetime; `lastActiveAt` drives inactivity expiry. */
export async function startSession(config: Config, res: Response, userId: Types.ObjectId, method: SessionMethod = "password") {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const maxAge = config.sessionMaxDays * 86_400_000;
  const now = new Date();
  await Session.create({ userId, tokenHash: sha256(token), csrfToken, method, expiresAt: new Date(now.getTime() + maxAge), lastActiveAt: now });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/", maxAge,
  });
  return csrfToken;
}

export function clearSessionCookie(config: Config, res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/" });
}

/** Every new user gets one generic default template (the sample they can edit). Other starters stay available via GET /email-templates/starters. */
export async function createStarterTemplates(userId: Types.ObjectId) {
  await EmailTemplate.insertMany(
    STARTERS.filter((s) => s.key === "generic").map((s) => ({
      userId, name: s.name, subject: s.subject, html: s.html, placeholderConfig: s.placeholderConfig,
      starterKey: s.key, isDefault: s.key === "generic", version: 1,
    })),
  );
}
