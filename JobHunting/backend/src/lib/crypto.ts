import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Encrypted { iv: string; tag: string; data: string }

/** AES-256-GCM. The key lives only in backend configuration. */
export function encryptSecret(plain: string, key: Buffer): Encrypted {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decryptSecret(enc: Encrypted, key: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  d.setAuthTag(Buffer.from(enc.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc.data, "base64")), d.final()]).toString("utf8");
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
