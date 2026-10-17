import xlsx from "xlsx";
import { ApiError } from "../errors.js";
import { isSafeUrl, isValidEmail } from "../lib/validation.js";

export const STANDARD_FIELDS = ["Name", "Company", "Email", "Role", "Link", "isSend"] as const;
export type StandardField = (typeof STANDARD_FIELDS)[number];
export const REQUIRED_FIELDS: StandardField[] = ["Name", "Company", "Email", "Role"];
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export type Mapping = Partial<Record<StandardField, string>>;
export interface NormalizedContact {
  Name: string; Company: string; Email: string; Role: string; Link: string | null; isSend: "yes" | "no" | null;
}
export interface ParsedRow {
  row: number; // 1-based row in the source (Excel: header is row 1; JSON: array index + 1)
  contact: NormalizedContact | null;
  status: "accepted" | "rejected" | "duplicate" | "skipped";
  errors: string[];
}
export interface ParsedFile {
  format: "xlsx" | "xls" | "json";
  worksheetName: string | null;
  headers: string[];
  mapping: Mapping;
  unknownColumns: string[];
  missingRequired: StandardField[];
  rows: ParsedRow[];
  counts: { total: number; accepted: number; rejected: number; duplicates: number; skipped: number };
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

/** Case/space-insensitive auto-mapping of source headers to the standard fields. */
export function suggestMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  for (const f of STANDARD_FIELDS) {
    const h = headers.find((x) => norm(x) === norm(f));
    if (h) m[f] = h;
  }
  return m;
}

export function detectFormat(filename: string, buf: Buffer): "xlsx" | "xls" | "json" {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "json") return "json";
  // xlsx = ZIP container (PK), xls = OLE2 compound file.
  if (ext === "xlsx" && buf.subarray(0, 2).toString("latin1") === "PK") return "xlsx";
  if (ext === "xls" && buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return "xls";
  throw new ApiError(415, "UNSUPPORTED_FILE_TYPE", "Upload a valid .xlsx, .xls or .json file.");
}

function normalizeRow(raw: Record<StandardField, string>): { contact: NormalizedContact | null; errors: string[] } {
  const errors: string[] = [];
  for (const f of REQUIRED_FIELDS) if (!raw[f]) errors.push(`Missing required field: ${f}`);
  if (raw.Email && !isValidEmail(raw.Email)) errors.push("Email address is malformed");
  for (const f of ["Name", "Company", "Role"] as const) if (raw[f].length > 200) errors.push(`${f} is longer than 200 characters`);
  const link: string | null = raw.Link || null;
  if (link && (link.length > 1000 || !isSafeUrl(link))) errors.push("Link must be an http(s) URL");
  const sendRaw = raw.isSend.toLowerCase();
  let isSend: "yes" | "no" | null = null;
  if (sendRaw) {
    if (["yes", "y", "true", "1"].includes(sendRaw)) isSend = "yes";
    else if (["no", "n", "false", "0"].includes(sendRaw)) isSend = "no";
    else errors.push('isSend must be "yes" or "no"');
  }
  if (errors.length) return { contact: null, errors };
  return { contact: { Name: raw.Name, Company: raw.Company, Email: raw.Email, Role: raw.Role, Link: link, isSend }, errors };
}

function finalize(rows: ParsedRow[], existingEmails: Set<string>): ParsedRow[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.status !== "accepted" || !r.contact) continue;
    const e = r.contact.Email.toLowerCase();
    if (seen.has(e)) { r.status = "duplicate"; r.errors.push("Duplicate email within this file"); }
    else if (existingEmails.has(e)) { r.status = "duplicate"; r.errors.push("Email already exists in your contacts"); }
    else seen.add(e);
  }
  return rows;
}

const countRows = (rows: ParsedRow[]) => ({
  total: rows.length,
  accepted: rows.filter((r) => r.status === "accepted").length,
  rejected: rows.filter((r) => r.status === "rejected").length,
  duplicates: rows.filter((r) => r.status === "duplicate").length,
  skipped: rows.filter((r) => r.status === "skipped").length,
});

export function parseUpload(
  filename: string,
  buf: Buffer,
  opts: { mapping?: Mapping; worksheet?: string; existingEmails: Set<string> },
): ParsedFile {
  const format = detectFormat(filename, buf);
  let headers: string[];
  const records: { row: number; values: Record<string, unknown> }[] = [];
  let worksheetName: string | null = null;

  if (format === "json") {
    let data: unknown;
    try { data = JSON.parse(buf.toString("utf8")); } catch { throw new ApiError(400, "INVALID_FILE", "The file is not valid JSON."); }
    if (!Array.isArray(data)) throw new ApiError(400, "INVALID_FILE", "JSON must be an array of recruiter objects.");
    if (data.length > MAX_IMPORT_ROWS) throw new ApiError(413, "TOO_MANY_ROWS", `At most ${MAX_IMPORT_ROWS} rows can be imported at once.`);
    const hs = new Set<string>();
    data.forEach((o, i) => {
      if (o && typeof o === "object" && !Array.isArray(o)) {
        Object.keys(o).forEach((k) => hs.add(k));
        records.push({ row: i + 1, values: o as Record<string, unknown> });
      } else records.push({ row: i + 1, values: {} });
    });
    headers = [...hs];
  } else {
    let wb: xlsx.WorkBook;
    try { wb = xlsx.read(buf, { type: "buffer", cellFormula: false, cellHTML: false }); }
    catch { throw new ApiError(400, "INVALID_FILE", "The spreadsheet could not be read."); }
    worksheetName = opts.worksheet && wb.SheetNames.includes(opts.worksheet) ? opts.worksheet : wb.SheetNames[0];
    if (!worksheetName) throw new ApiError(400, "INVALID_FILE", "The workbook has no worksheets.");
    const rows = xlsx.utils.sheet_to_json<unknown[]>(wb.Sheets[worksheetName], { header: 1, defval: null, blankrows: true });
    if (rows.length - 1 > MAX_IMPORT_ROWS) throw new ApiError(413, "TOO_MANY_ROWS", `At most ${MAX_IMPORT_ROWS} rows can be imported at once.`);
    headers = (rows[0] ?? []).map(cell).filter(Boolean);
    const headerRow = (rows[0] ?? []).map(cell);
    for (let i = 1; i < rows.length; i++) {
      const values: Record<string, unknown> = {};
      headerRow.forEach((h, c) => { if (h) values[h] = (rows[i] ?? [])[c]; });
      records.push({ row: i + 1, values });
    }
  }

  const mapping: Mapping = { ...suggestMapping(headers), ...(opts.mapping ?? {}) };
  for (const f of STANDARD_FIELDS) if (mapping[f] && !headers.includes(mapping[f]!)) delete mapping[f];
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  const mapped = new Set(Object.values(mapping));
  const unknownColumns = headers.filter((h) => !mapped.has(h));

  const rows: ParsedRow[] = records.map(({ row, values }) => {
    const raw = Object.fromEntries(STANDARD_FIELDS.map((f) => [f, mapping[f] ? cell(values[mapping[f]!]) : ""])) as Record<StandardField, string>;
    if (STANDARD_FIELDS.every((f) => !raw[f]) && Object.values(values).every((v) => cell(v) === "")) {
      return { row, contact: null, status: "skipped" as const, errors: ["Empty row"] };
    }
    if (missingRequired.length) return { row, contact: null, status: "rejected" as const, errors: [`Column not mapped: ${missingRequired.join(", ")}`] };
    const { contact, errors } = normalizeRow(raw);
    return { row, contact, status: contact ? ("accepted" as const) : ("rejected" as const), errors };
  });
  finalize(rows, opts.existingEmails);
  return { format, worksheetName, headers, mapping, unknownColumns, missingRequired, rows, counts: countRows(rows) };
}

/** Neutralises spreadsheet formula injection in exported cells. */
export const safeCell = (v: string | null): string => (v && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v ?? "");

export const SAMPLE_JSON = [
  { Name: "Jane Doe", Company: "Example Corp", Email: "jane.doe@example.com", Role: "Senior Frontend Engineer", Link: "https://example.com/jobs/123", isSend: "yes" },
];
