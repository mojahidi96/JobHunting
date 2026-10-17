import { rateLimit } from "express-rate-limit";
import type { RequestHandler } from "express";
import type { Config } from "../config/env.js";

export function limiter(config: Config, windowMs: number, max: number, message: string): RequestHandler {
  if (!config.rateLimits) return (_req, _res, next) => next();
  return rateLimit({
    windowMs, limit: max, standardHeaders: "draft-7", legacyHeaders: false,
    handler: (_req, res) => { res.status(429).json({ error: { code: "RATE_LIMITED", message, details: [] } }); },
  });
}
