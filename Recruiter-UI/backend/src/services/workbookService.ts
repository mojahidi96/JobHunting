import fs from "node:fs";
import path from "node:path";
import xlsx from "xlsx";
import { ApiError } from "../errors.js";
import type { Config } from "../config/env.js";
import type { Recruiter } from "../types/index.js";

export const REQUIRED_COLUMNS = ["Name", "Company", "Email", "Role"] as const;

export type WorkbookRecruiter = Omit<Recruiter, "status" | "lastError" | "sentAt">;

export interface WorkbookData {
  items: WorkbookRecruiter[];
  source: { fileName: string; sheetName: string };
  warnings: string[];
}

function cell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Reads the workbook fresh on every call so edits to the file are picked up. */
export function readWorkbook(config: Pick<Config, "excelPath" | "sheetName">): WorkbookData {
  if (!config.excelPath) {
    throw new ApiError(500, "WORKBOOK_NOT_CONFIGURED", "The recruiter workbook is not configured.");
  }
  let wb: xlsx.WorkBook;
  try {
    wb = xlsx.read(fs.readFileSync(config.excelPath), { type: "buffer" });
  } catch {
    throw new ApiError(500, "WORKBOOK_UNREADABLE", "The recruiter workbook could not be read.");
  }
  const sheet = wb.Sheets[config.sheetName];
  if (!sheet) {
    throw new ApiError(500, "SHEET_NOT_FOUND", `Worksheet "${config.sheetName}" was not found in the workbook.`);
  }
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: true });
  const header = (rows[0] ?? []).map((h) => cell(h) ?? "");
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new ApiError(500, "MISSING_COLUMNS", "The worksheet is missing required columns.", [...missing]);
  }
  const idx = (name: string) => header.indexOf(name);
  const warnings: string[] = [];
  if (idx("Link") < 0) warnings.push('Optional column "Link" is not present.');
  if (idx("isSend") < 0) warnings.push('Optional column "isSend" is not present.');

  const items: WorkbookRecruiter[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (r.every((v) => cell(v) === null)) continue;
    const get = (n: string) => (idx(n) >= 0 ? cell(r[idx(n)]) : null);
    const rowNumber = i + 1;
    items.push({
      id: `row-${rowNumber}`,
      rowNumber,
      Name: get("Name") ?? "",
      Company: get("Company") ?? "",
      Email: get("Email") ?? "",
      Role: get("Role") ?? "",
      Link: get("Link"),
      isSend: get("isSend"),
    });
  }
  return {
    items,
    source: { fileName: path.basename(config.excelPath), sheetName: config.sheetName },
    warnings,
  };
}
