import { Router } from "express";
import multer from "multer";
import xlsx from "xlsx";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ApiError } from "../errors.js";
import { contactDto, importDto } from "../lib/dto.js";
import { escapeRegex, isSafeUrl, isValidEmail, objectId, parse } from "../lib/validation.js";
import { requireAuth } from "../middleware/auth.js";
import { limiter } from "../middleware/rateLimit.js";
import { ImportRecord, RecruiterContact } from "../models/index.js";
import {
  MAX_IMPORT_BYTES, SAMPLE_JSON, STANDARD_FIELDS, parseUpload, safeCell, type Mapping,
} from "../services/importService.js";
import { Types } from "mongoose";

const contactBody = z.object({
  Name: z.string().trim().min(1, "required").max(200),
  Company: z.string().trim().min(1, "required").max(200),
  Email: z.string().trim().refine(isValidEmail, "must be a valid email address"),
  Role: z.string().trim().min(1, "required").max(200),
  Link: z.string().trim().max(1000).nullish().transform((v) => v || null).refine((v) => v === null || isSafeUrl(v), "must be an http(s) URL"),
  isSend: z.enum(["yes", "no"]).nullish().transform((v) => v ?? null),
}).strict();

const SORT_FIELDS = ["Name", "Company", "Email", "Role", "createdAt", "deliveryStatus"] as const;
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  isSend: z.enum(["yes", "no", "unset"]).optional(),
  status: z.enum(["pending", "sent", "failed", "skipped"]).optional(),
  importId: objectId.optional(),
  sort: z.enum(SORT_FIELDS).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

function buildFilter(userId: Types.ObjectId, q: z.infer<typeof listQuery>) {
  const f: Record<string, unknown> = { userId };
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), "i");
    f.$or = [{ Name: re }, { Company: re }, { Email: re }, { Role: re }];
  }
  if (q.isSend === "unset") f.isSend = null; else if (q.isSend) f.isSend = q.isSend;
  if (q.status === "pending") f.lastDelivery = null; else if (q.status) f["lastDelivery.status"] = q.status;
  if (q.importId) f["source.importId"] = new Types.ObjectId(q.importId);
  return f;
}
const sortKey = (s: (typeof SORT_FIELDS)[number]) => (s === "deliveryStatus" ? "lastDelivery.status" : s);

const mappingSchema = z.partialRecord(z.enum(STANDARD_FIELDS), z.string().max(200));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });

function readUpload(req: import("express").Request) {
  if (!req.file) throw new ApiError(400, "VALIDATION_ERROR", 'Upload a file in the "file" field.');
  let mapping: Mapping | undefined;
  if (typeof req.body?.mapping === "string" && req.body.mapping) {
    try { mapping = parse(mappingSchema, JSON.parse(req.body.mapping)); }
    catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(400, "VALIDATION_ERROR", "mapping must be a JSON object."); }
  }
  const worksheet = typeof req.body?.worksheet === "string" ? req.body.worksheet.slice(0, 200) : undefined;
  return { file: req.file, mapping, worksheet };
}

export function recruiterRoutes(config: Config) {
  const r = Router();
  r.use(requireAuth(config));

  const emailsOf = async (userId: Types.ObjectId) =>
    new Set((await RecruiterContact.find({ userId }).select("emailLower").lean()).map((c) => c.emailLower));

  /* ----------------------------------------------------------- contacts */
  r.get("/recruiters", async (req, res) => {
    const q = parse(listQuery, req.query);
    const filter = buildFilter(req.auth!.userId, q);
    const [items, total] = await Promise.all([
      RecruiterContact.find(filter).sort({ [sortKey(q.sort)]: q.order === "asc" ? 1 : -1, _id: 1 })
        .collation({ locale: "en", strength: 2 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      RecruiterContact.countDocuments(filter),
    ]);
    res.json({ items: items.map(contactDto), total, page: q.page, pageSize: q.pageSize });
  });

  r.post("/recruiters", async (req, res) => {
    const body = parse(contactBody, req.body);
    try {
      const c = await RecruiterContact.create({ ...body, userId: req.auth!.userId, emailLower: body.Email.toLowerCase(), source: { type: "manual" } });
      res.status(201).json({ item: contactDto(c) });
    } catch (e: any) {
      if (e?.code === 11000) throw new ApiError(409, "DUPLICATE_CONTACT", "A contact with this email already exists.");
      throw e;
    }
  });

  /* Export must be declared before /recruiters/:id. */
  const exportQuery = listQuery.partial({ sort: true, order: true, page: true, pageSize: true }).extend({
    format: z.enum(["xlsx", "json"]),
    scope: z.enum(["all", "filtered", "selected"]).default("all"),
    ids: z.string().max(20_000).optional(),
    includeStatus: z.enum(["true", "false"]).default("false"),
  });
  r.get("/recruiters/export", limiter(config, 60_000, 20, "Too many exports."), async (req, res) => {
    const q = parse(exportQuery, req.query);
    const userId = req.auth!.userId;
    let filter: Record<string, unknown> = { userId };
    if (q.scope === "filtered") filter = buildFilter(userId, { ...q, sort: "createdAt", order: "desc", page: 1, pageSize: 1 });
    if (q.scope === "selected") {
      const ids = (q.ids ?? "").split(",").filter(Boolean);
      if (!ids.length || ids.length > 1000 || !ids.every((i) => /^[a-f\d]{24}$/i.test(i))) {
        throw new ApiError(400, "VALIDATION_ERROR", "scope=selected needs 1-1000 valid ids.", ["ids: invalid"]);
      }
      filter = { userId, _id: { $in: ids.map((i) => new Types.ObjectId(i)) } };
    }
    const docs = await RecruiterContact.find(filter).sort({ createdAt: 1 }).limit(20_000).lean();
    const withStatus = q.includeStatus === "true";
    const rows = docs.map((c) => ({
      Name: c.Name, Company: c.Company, Email: c.Email, Role: c.Role, Link: c.Link ?? "", isSend: c.isSend ?? "",
      ...(withStatus ? { deliveryStatus: c.lastDelivery?.status ?? "pending" } : {}),
    }));
    if (q.format === "json") {
      res.setHeader("Content-Disposition", 'attachment; filename="recruiters.json"');
      res.type("application/json").send(JSON.stringify(rows, null, 2));
      return;
    }
    const safe = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safeCell(v)])));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(safe), "Recruiters_Email");
    res.setHeader("Content-Disposition", 'attachment; filename="recruiters.xlsx"');
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
  });

  r.patch("/recruiters/:id", async (req, res) => {
    const id = parse(objectId, req.params.id);
    const body = parse(contactBody.partial(), req.body);
    const set: Record<string, unknown> = { ...body };
    if (body.Email) set.emailLower = body.Email.toLowerCase();
    try {
      const c = await RecruiterContact.findOneAndUpdate({ _id: id, userId: req.auth!.userId }, { $set: set }, { returnDocument: "after", runValidators: true });
      if (!c) throw new ApiError(404, "NOT_FOUND", "Contact not found.");
      res.json({ item: contactDto(c) });
    } catch (e: any) {
      if (e?.code === 11000) throw new ApiError(409, "DUPLICATE_CONTACT", "A contact with this email already exists.");
      throw e;
    }
  });

  r.delete("/recruiters/:id", async (req, res) => {
    const id = parse(objectId, req.params.id);
    const d = await RecruiterContact.deleteOne({ _id: id, userId: req.auth!.userId });
    if (!d.deletedCount) throw new ApiError(404, "NOT_FOUND", "Contact not found.");
    res.json({ ok: true });
  });

  r.post("/recruiters/bulk-delete", async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(objectId).min(1).max(1000) }), req.body);
    const d = await RecruiterContact.deleteMany({ userId: req.auth!.userId, _id: { $in: ids } });
    res.json({ deleted: d.deletedCount });
  });

  /* ------------------------------------------------------------ imports */
  const importLimit = limiter(config, 60_000, 30, "Too many imports. Try again shortly.");

  r.get("/imports/sample", (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="recruiters-sample.json"');
    res.type("application/json").send(JSON.stringify(SAMPLE_JSON, null, 2));
  });

  r.post("/imports/preview", importLimit, upload.single("file"), async (req, res) => {
    const { file, mapping, worksheet } = readUpload(req);
    const parsed = parseUpload(file.originalname, file.buffer, { mapping, worksheet, existingEmails: await emailsOf(req.auth!.userId) });
    res.json({
      file: { name: file.originalname.slice(0, 255), format: parsed.format, worksheetName: parsed.worksheetName },
      headers: parsed.headers, mapping: parsed.mapping, unknownColumns: parsed.unknownColumns, missingRequired: parsed.missingRequired,
      counts: parsed.counts,
      rows: parsed.rows.slice(0, 200).map((x) => ({ row: x.row, status: x.status, errors: x.errors, contact: x.contact })),
      truncated: parsed.rows.length > 200,
    });
  });

  r.post("/imports", importLimit, upload.single("file"), async (req, res) => {
    const { file, mapping, worksheet } = readUpload(req);
    const userId = req.auth!.userId;
    const parsed = parseUpload(file.originalname, file.buffer, { mapping, worksheet, existingEmails: await emailsOf(userId) });
    if (parsed.missingRequired.length) {
      throw new ApiError(422, "MISSING_COLUMNS", "Map all required columns before importing.", [...parsed.missingRequired]);
    }
    const accepted = parsed.rows.filter((x) => x.status === "accepted" && x.contact);
    if (!accepted.length) throw new ApiError(422, "NOTHING_TO_IMPORT", "No valid new rows to import.", parsed.rows.slice(0, 20).map((x) => `row ${x.row}: ${x.errors.join("; ")}`));

    const rec = new ImportRecord({
      userId, originalFilename: file.originalname.slice(0, 255), format: parsed.format, worksheetName: parsed.worksheetName,
      mapping: parsed.mapping, counts: { ...parsed.counts, accepted: 0 },
      rowErrors: parsed.rows.filter((x) => x.status !== "accepted").slice(0, 200).map((x) => ({ row: x.row, messages: x.errors })),
      storageRef: `imports/${new Types.ObjectId().toHexString()}`,
    });
    let inserted: number;
    try {
      const res2 = await RecruiterContact.insertMany(
        accepted.map((x) => ({ ...x.contact!, userId, emailLower: x.contact!.Email.toLowerCase(), source: { type: "import", importId: rec._id } })),
        { ordered: false },
      );
      inserted = res2.length;
    } catch (e: any) {
      // Concurrent duplicates: keep what was inserted.
      inserted = e?.insertedDocs?.length ?? e?.result?.insertedCount ?? 0;
      if (!inserted && e?.code !== 11000 && !e?.writeErrors) throw e;
    }
    rec.counts!.accepted = inserted;
    rec.counts!.duplicates = (rec.counts!.duplicates ?? 0) + (accepted.length - inserted);
    await rec.save();
    res.status(201).json({ import: importDto(rec) });
  });

  r.get("/imports", async (req, res) => {
    const items = await ImportRecord.find({ userId: req.auth!.userId }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ items: items.map(importDto) });
  });

  r.delete("/imports/:id", async (req, res) => {
    const id = parse(objectId, req.params.id);
    const opts = parse(z.object({ deleteContacts: z.enum(["true", "false"]).default("false") }), req.query);
    const rec = await ImportRecord.findOneAndDelete({ _id: id, userId: req.auth!.userId });
    if (!rec) throw new ApiError(404, "NOT_FOUND", "Import not found.");
    let deletedContacts = 0;
    if (opts.deleteContacts === "true") deletedContacts = (await RecruiterContact.deleteMany({ userId: req.auth!.userId, "source.importId": rec._id })).deletedCount;
    else await RecruiterContact.updateMany({ userId: req.auth!.userId, "source.importId": rec._id }, { $set: { "source.importId": null } });
    res.json({ ok: true, deletedContacts });
  });

  return r;
}
