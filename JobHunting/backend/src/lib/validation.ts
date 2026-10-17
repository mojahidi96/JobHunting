import { z } from "zod";
import { ApiError } from "../errors.js";

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const isValidEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e);

export function isSafeUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Empty string or an http(s) URL. */
export const urlOrEmpty = (max = 500) =>
  z.string().trim().max(max).refine((v) => v === "" || isSafeUrl(v), "must be an http(s) URL");

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "The request is invalid.", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  }
  return r.data;
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
