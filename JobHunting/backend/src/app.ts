import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import multer from "multer";
import type { Config } from "./config/env.js";
import { ApiError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { emailRoutes } from "./routes/emails.js";
import { profileRoutes } from "./routes/profile.js";
import { recruiterRoutes } from "./routes/recruiters.js";
import { settingsRoutes } from "./routes/settings.js";
import { templateRoutes } from "./routes/templates.js";
import type { JobRunner } from "./services/jobRunner.js";
import type { MailerFactory } from "./services/mailService.js";
import type { GoogleClient } from "./services/googleService.js";
import type { AuthMailer } from "./services/authMailer.js";

export interface AppDeps { config: Config; mailerFactory: MailerFactory; runner: JobRunner; googleClient: GoogleClient | null; authMailer: AuthMailer | null }

export function createApp({ config, mailerFactory, runner, googleClient, authMailer }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  if (config.env === "production") app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "300kb" }));

  const api = express.Router();
  api.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "jobhunting-api", database: mongoose.connection.readyState === 1 ? "up" : "down" });
  });
  api.use("/auth", authRoutes(config, { googleClient, authMailer }));
  api.use("/settings", settingsRoutes(config, mailerFactory, { googleClient }));
  api.use("/email-templates", templateRoutes(config));
  api.use("/emails", emailRoutes(config, runner));
  api.use(profileRoutes(config));
  api.use(recruiterRoutes(config));
  api.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Route not found.")));
  app.use("/api", api);
  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Route not found.")));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const send = (status: number, code: string, message: string, details: unknown[] = [], meta?: Record<string, unknown>) =>
      res.status(status).json({ error: { code, message, details, ...(meta ? { meta } : {}) } });
    if (err instanceof ApiError) return void send(err.status, err.code, err.message, err.details, err.meta);
    if (err instanceof multer.MulterError) {
      return void (err.code === "LIMIT_FILE_SIZE" ? send(413, "PAYLOAD_TOO_LARGE", "The file is too large.") : send(400, "VALIDATION_ERROR", "Invalid upload."));
    }
    if (err?.type === "entity.parse.failed") return void send(400, "VALIDATION_ERROR", "Request body is not valid JSON.");
    if (err?.type === "entity.too.large") return void send(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
    console.error("Unhandled error:", err instanceof Error ? err.name : "unknown"); // message omitted: may contain URIs
    send(500, "INTERNAL_ERROR", "An unexpected error occurred.");
  };
  app.use(onError);
  return app;
}
