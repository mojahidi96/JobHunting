import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { ApiError } from "./errors.js";
import { missingEnv, type Config } from "./config/env.js";
import { readWorkbook, type WorkbookRecruiter } from "./services/workbookService.js";
import { renderEmail } from "./services/emailTemplateService.js";
import type { EmailJobService } from "./services/emailJobService.js";
import { parse, previewSchema, sendSchema } from "./validators/requests.js";
import type { Recruiter } from "./types/index.js";

export function createApp(config: Config, jobs: EmailJobService) {
  const app = express();
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: "100kb" }));

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "recruiter-outreach-api" });
  });

  api.get("/recruiters", (_req, res) => {
    const wb = readWorkbook(config);
    const items: Recruiter[] = wb.items.map((r) => ({ ...r, status: "pending", ...jobs.deliveryFor(r.id) }));
    res.json({ items, source: wb.source, warnings: wb.warnings });
  });

  const resolve = (ids: string[]): WorkbookRecruiter[] => {
    const wb = readWorkbook(config);
    const byId = new Map(wb.items.map((r) => [r.id, r]));
    const unique = [...new Set(ids)];
    const unknown = unique.filter((id) => !byId.has(id));
    if (unknown.length) throw new ApiError(404, "RECRUITER_NOT_FOUND", "Some recruiter ids were not found in the workbook.", unknown);
    return unique.map((id) => byId.get(id)!);
  };

  api.post("/emails/preview", (req, res) => {
    const body = parse(previewSchema, req.body);
    const recruiters = resolve(body.recruiterIds);
    res.json({ items: recruiters.map((r) => renderEmail(r, body.template, config)) });
  });

  api.post("/emails/send", (req, res) => {
    const body = parse(sendSchema, req.body);
    if (body.confirmation !== true) {
      throw new ApiError(400, "CONFIRMATION_REQUIRED", "Sending requires confirmation: true.");
    }
    const missing = missingEnv(config).filter((n) => n !== "EXCEL_PATH");
    if (missing.length) {
      throw new ApiError(503, "SMTP_NOT_CONFIGURED", "Email sending is not configured on the server.", missing);
    }
    const recruiters = resolve(body.recruiterIds);
    const job = jobs.createJob(recruiters, body.template, body.options);
    res.status(202).json({ jobId: job.jobId, status: job.status, total: job.total, message: "Email job queued." });
  });

  api.get("/emails/jobs/:jobId", (req, res) => {
    res.json(jobs.getJob(req.params.jobId));
  });

  api.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Route not found.")));
  app.use("/api", api);
  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Route not found.")));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON.", details: [] } });
      return;
    }
    if (err?.type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large.", details: [] } });
      return;
    }
    console.error("Unhandled error:", err instanceof Error ? err.message : "unknown");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", details: [] } });
  };
  app.use(onError);
  return app;
}
