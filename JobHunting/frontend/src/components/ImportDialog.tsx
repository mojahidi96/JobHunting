import { useRef, useState } from "react";
import { api, download } from "../api";
import type { ImportPreview, ImportRecord } from "../types";
import { Alert, ErrorAlert, Modal } from "./common";
import { UploadIcon } from "./icons";
import { Button, Select, Stat, tableClasses as t } from "./ui";

const FIELDS = ["Name", "Company", "Email", "Role", "Link", "isSend"] as const;
const REQUIRED = ["Name", "Company", "Email", "Role"];

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);

  async function runPreview(f: File, m: Record<string, string>) {
    setBusy(true); setError(null);
    try { const p = await api.previewImport(f, m); setPreview(p); setMapping(p.mapping); }
    catch (e) { setError(e); setPreview(null); } finally { setBusy(false); }
  }
  async function doImport() {
    if (!file) return;
    setBusy(true); setError(null);
    try { const r = await api.runImport(file, mapping); setResult(r.import); onImported(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const change = (field: string, header: string) => {
    const m = { ...mapping }; if (header) m[field] = header; else delete m[field];
    setMapping(m); if (file) void runPreview(file, m);
  };

  return (
    <Modal title="Import recruiters" size="lg" onClose={onClose} footer={result ? <Button variant="primary" onClick={onClose}>Done</Button> : <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={!preview || preview.missingRequired.length > 0 || preview.counts.accepted === 0} onClick={doImport}>{`Import ${preview?.counts.accepted ?? 0} contacts`}</Button>
    </>}>
      <ErrorAlert error={error} />
      {result ? (
        <Alert kind="ok">
          <p><strong>Imported {result.counts.accepted} contacts</strong> from {result.originalFilename}{result.worksheetName ? ` (sheet ${result.worksheetName})` : ""}.</p>
          <p>{result.counts.rejected} rejected · {result.counts.duplicates} duplicates · {result.counts.skipped} empty rows skipped. No emails were sent.</p>
        </Alert>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted">Upload an <code>.xlsx</code> file (first worksheet) or a <code>.json</code> array. Nothing is saved or sent until you click Import.</p>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed border-border bg-surface-muted p-4">
            <UploadIcon className="size-6 text-primary" />
            <input ref={input} type="file" accept=".xlsx,.xls,.json" aria-label="Choose file to import" className="min-w-0 flex-1 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-foreground"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setPreview(null); if (f) void runPreview(f, {}); }} />
            <Button size="sm" onClick={async () => download(await api.sampleJson(), "recruiters-sample.json")}>Download sample JSON</Button>
          </div>
          {busy && !preview && <p className="text-sm text-muted" role="status">Reading file…</p>}
          {preview && (
            <>
              <dl className="grid gap-3 rounded-lg bg-surface-muted p-3 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-muted">Source</dt><dd>Uploaded file</dd></div>
                <div><dt className="text-xs text-muted">File</dt><dd className="break-all">{preview.file.name}</dd></div>
                <div><dt className="text-xs text-muted">Worksheet</dt><dd>{preview.file.worksheetName ?? "— (JSON)"}</dd></div>
              </dl>
              <fieldset className="rounded-lg border border-border p-3">
                <legend className="px-1 text-sm font-medium">Column mapping</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <label key={f} className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-sm">{f}{REQUIRED.includes(f) ? " *" : ""}
                      <Select value={mapping[f] ?? ""} onChange={(e) => change(f, e.target.value)}>
                        <option value="">— not mapped —</option>
                        {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </Select>
                    </label>
                  ))}
                </div>
                {preview.unknownColumns.length > 0 && <p className="mt-2 text-xs text-muted">Ignored columns: {preview.unknownColumns.join(", ")}</p>}
              </fieldset>
              {preview.missingRequired.length > 0 && <Alert kind="warn">Map the required columns: {preview.missingRequired.join(", ")}.</Alert>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="group" aria-label="Validation summary">
                <Stat label="Accepted" value={preview.counts.accepted} tone="success" /><Stat label="Rejected" value={preview.counts.rejected} tone={preview.counts.rejected ? "danger" : "neutral"} />
                <Stat label="Duplicates" value={preview.counts.duplicates} /><Stat label="Empty" value={preview.counts.skipped} />
              </div>
              {preview.rows.some((r) => r.status !== "accepted") && (
                <div className="overflow-x-auto rounded-lg border border-border" tabIndex={0} aria-label="Row problems">
                  <table className="w-full text-left text-sm">
                    <thead className={t.thead.replace("max-md:sr-only", "")}><tr><th className={t.th}>Row</th><th className={t.th}>Result</th><th className={t.th}>Details</th></tr></thead>
                    <tbody>{preview.rows.filter((r) => r.status !== "accepted").slice(0, 50).map((r) => (
                      <tr key={r.row} className="border-t border-border"><td className="px-4 py-2">{r.row}</td><td className="px-4 py-2">{r.status}</td><td className="px-4 py-2">{r.errors.join("; ")}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
