import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import xlsx from "xlsx";

export function writeWorkbook(rows: unknown[][], sheetName = "Recruiters_Email"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  const file = path.join(dir, "recruiters.xlsx");
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), sheetName);
  fs.writeFileSync(file, xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
  return file;
}

export const HEADER = ["Name", "Company", "Email", "Role", "Link", "isSend"];
