import { useCallback, useEffect, useMemo, useState } from "react";
import { api, download } from "../api";
import { Dash, ErrorAlert, Pagination, StatusBadge, fmtDate } from "../components/common";
import { useConfirm } from "../components/confirm";
import { UploadIcon, UsersIcon } from "../components/icons";
import { ImportDialog } from "../components/ImportDialog";
import { SendDialog } from "../components/SendDialog";
import { Button, Card, Checkbox, EmptyState, Field, Input, PageHeader, Select, SkeletonRows, tableClasses as t, useToast } from "../components/ui";
import type { Contact, ContactInput, ImportRecord } from "../types";

const EMPTY: ContactInput = { Name: "", Company: "", Email: "", Role: "", Link: null, isSend: null };
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const CELL_INPUT = "min-h-9";

function validate(d: ContactInput): string[] {
  const e: string[] = [];
  for (const k of ["Name", "Company", "Email", "Role"] as const) if (!d[k].trim()) e.push(`${k} is required`);
  if (d.Email.trim() && !EMAIL_RE.test(d.Email.trim())) e.push("Email is not a valid address");
  if (d.Link && !/^https?:\/\//i.test(d.Link)) e.push("Link must start with http:// or https://");
  return e;
}
const safeHref = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

export function RecruitersPage() {
  const [f, setF] = useState({ q: "", isSend: "", status: "", sort: "createdAt", order: "desc", page: 1 });
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ items: Contact[]; total: number; pageSize: number } | null>(null);
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ id: string | "new"; draft: ContactInput } | null>(null);
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [dlg, setDlg] = useState<"import" | "send" | null>(null);
  const [exp, setExp] = useState({ format: "xlsx", scope: "all", includeStatus: false });
  const toast = useToast();
  const confirm = useConfirm();
  const pageSize = 25;

  const query = useMemo(() => ({ q: f.q, isSend: f.isSend, status: f.status, sort: f.sort, order: f.order, page: f.page, pageSize }), [f]);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [c, i] = await Promise.all([api.contacts(query), api.imports()]);
      setData({ items: c.items, total: c.total, pageSize: c.pageSize }); setImports(i.items);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const x = setTimeout(() => setF((s) => (s.q === q ? s : { ...s, q, page: 1 })), 300); return () => clearTimeout(x); }, [q]);

  const importById = useMemo(() => new Map(imports.map((i) => [i.id, i])), [imports]);
  const sourceOf = (c: Contact) => {
    if (c.source.type === "manual") return "Manual entry";
    const i = c.source.importId ? importById.get(c.source.importId) : undefined;
    return i ? `${i.originalFilename}${i.worksheetName ? ` · ${i.worksheetName}` : ""}` : "Imported file";
  };
  const sort = (col: string) => setF((x) => ({ ...x, sort: col, order: x.sort === col && x.order === "asc" ? "desc" : "asc", page: 1 }));
  const ariaSort = (col: string) => (f.sort === col ? (f.order === "asc" ? "ascending" : "descending") : "none");

  async function saveRow() {
    if (!edit) return;
    const d = { ...edit.draft, Name: edit.draft.Name.trim(), Company: edit.draft.Company.trim(), Email: edit.draft.Email.trim(), Role: edit.draft.Role.trim(), Link: edit.draft.Link?.trim() || null };
    const errs = validate(d);
    if (errs.length) { setRowErrors(errs); return; }
    try {
      if (edit.id === "new") await api.createContact(d); else await api.updateContact(edit.id, d);
      toast("success", edit.id === "new" ? "Contact added." : "Contact updated.");
      setEdit(null); setRowErrors([]); await load();
    } catch (e) { setRowErrors([(e as Error).message, ...(((e as { details?: string[] }).details) ?? [])]); }
  }
  async function remove(c: Contact) {
    if (!(await confirm({ title: "Delete recruiter?", message: `${c.Name} (${c.Email}) will be removed from your contacts. Their email history is kept.`, confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.deleteContact(c.id); setSelected((s) => { const n = new Set(s); n.delete(c.id); return n; }); toast("success", "Contact deleted."); await load(); } catch (e) { setError(e); }
  }
  async function bulkDelete() {
    if (!(await confirm({ title: `Delete ${selected.size} recruiter${selected.size === 1 ? "" : "s"}?`, message: "The selected contacts will be removed. Their email history is kept.", confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.bulkDelete([...selected]); setSelected(new Set()); toast("success", "Contacts deleted."); await load(); } catch (e) { setError(e); }
  }
  async function selectAllMatching() {
    try {
      const ids: string[] = [];
      for (let p = 1; ids.length < 500; p++) { const r = await api.contacts({ ...query, page: p, pageSize: 200 }); ids.push(...r.items.map((c) => c.id)); if (ids.length >= r.total || !r.items.length) break; }
      setSelected(new Set(ids.slice(0, 500)));
    } catch (e) { setError(e); }
  }
  async function doExport() {
    try {
      const blob = await api.exportContacts({ format: exp.format, scope: exp.scope, ids: exp.scope === "selected" ? [...selected].join(",") : undefined, includeStatus: exp.includeStatus, q: f.q, isSend: f.isSend, status: f.status });
      download(blob, `recruiters.${exp.format}`); toast("success", "Export ready.");
    } catch (e) { setError(e); }
  }

  const items = data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((c) => selected.has(c.id));
  const toggleAll = () => setSelected((s) => { const n = new Set(s); items.forEach((c) => (allOnPage ? n.delete(c.id) : n.add(c.id))); return n; });
  const draft = edit?.draft;
  const setD = (k: keyof ContactInput, v: string) => setEdit((e) => e && { ...e, draft: { ...e.draft, [k]: k === "isSend" ? (v || null) : v } as ContactInput });
  const startAdd = () => { setEdit({ id: "new", draft: { ...EMPTY } }); setRowErrors([]); };
  const filtered = !!(f.q || f.isSend || f.status);

  const editorRow = (id: string) => draft && (
    <tr className={`${t.tr} bg-primary-soft/50`} key={id}>
      <td data-label="Select" className={t.td} />
      <td data-label="Name" className={t.td}><Input className={CELL_INPUT} aria-label="Name" value={draft.Name} onChange={(e) => setD("Name", e.target.value)} required /></td>
      <td data-label="Company" className={t.td}><Input className={CELL_INPUT} aria-label="Company" value={draft.Company} onChange={(e) => setD("Company", e.target.value)} required /></td>
      <td data-label="Email" className={t.td}><Input className={CELL_INPUT} aria-label="Email" type="email" value={draft.Email} onChange={(e) => setD("Email", e.target.value)} required /></td>
      <td data-label="Role" className={t.td}><Input className={CELL_INPUT} aria-label="Role" value={draft.Role} onChange={(e) => setD("Role", e.target.value)} required /></td>
      <td data-label="Link" className={t.td}><Input className={CELL_INPUT} aria-label="Link" type="url" placeholder="https://…" value={draft.Link ?? ""} onChange={(e) => setD("Link", e.target.value)} /></td>
      <td data-label="isSend" className={t.td}><Select className={CELL_INPUT} aria-label="isSend" value={draft.isSend ?? ""} onChange={(e) => setD("isSend", e.target.value)}><option value="">—</option><option value="yes">yes</option><option value="no">no</option></Select></td>
      <td data-label="Delivery" className={t.td} />
      <td data-label="Source" className={t.td}>{id === "new" ? "Manual entry" : ""}</td>
      <td data-label="Actions" className={t.td}>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" onClick={saveRow}>Save</Button><Button size="sm" onClick={() => { setEdit(null); setRowErrors([]); }}>Cancel</Button></div>
        {rowErrors.length > 0 && <ul className="mt-2 list-disc pl-4 text-xs text-danger" role="alert">{rowErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      </td>
    </tr>
  );

  return (
    <>
      <PageHeader title="Recruiters" description="Add contacts manually or import them. Nothing is sent until you review and confirm."
        actions={<>
          <Button variant="primary" disabled={selected.size === 0} onClick={() => setDlg("send")}>Send emails ({selected.size})</Button>
          <Button onClick={() => setDlg("import")}><UploadIcon className="size-4" /> Import file</Button>
          <Button onClick={startAdd}>Add recruiter</Button>
        </>} />
      <ErrorAlert error={error} onRetry={load} />

      <details className="group mb-4 rounded-xl border border-border bg-surface shadow-card">
        <summary className="cursor-pointer px-5 py-3 text-sm font-medium">Data sources ({imports.length} import{imports.length === 1 ? "" : "s"} + manual entry)</summary>
        <div className="border-t border-border px-5 py-4 text-sm">
          {imports.length === 0 ? <p className="text-muted">No files imported yet. Add contacts manually or import an .xlsx / .json file.</p> : (
            <ul className="grid gap-4 md:grid-cols-2">{imports.map((i) => (
              <li key={i.id}><dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 rounded-lg bg-surface-muted p-3">
                <dt className="text-muted">Source</dt><dd>Uploaded file</dd><dt className="text-muted">File</dt><dd className="break-all">{i.originalFilename}</dd>
                <dt className="text-muted">Worksheet</dt><dd><Dash v={i.worksheetName} /></dd><dt className="text-muted">Imported</dt><dd>{fmtDate(i.importedAt)}</dd>
                <dt className="text-muted">Rows</dt><dd>{i.counts.accepted} added · {i.counts.rejected} rejected · {i.counts.duplicates} duplicates</dd>
                <dt className="text-muted">Reference</dt><dd className="break-all">{i.storageRef} <span className="text-xs text-muted">(file not retained)</span></dd></dl></li>
            ))}</ul>
          )}
        </div>
      </details>

      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4" role="search">
        <Field className="sm:col-span-2" label="Search">{(a) => <Input {...a} type="search" value={q} placeholder="Name, company, email, role" onChange={(e) => setQ(e.target.value)} />}</Field>
        <Field label="isSend (source data)">{(a) => <Select {...a} value={f.isSend} onChange={(e) => setF({ ...f, isSend: e.target.value, page: 1 })}><option value="">Any</option><option value="yes">yes</option><option value="no">no</option><option value="unset">not set</option></Select>}</Field>
        <Field label="Delivery status">{(a) => <Select {...a} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">Any</option><option value="pending">Pending</option><option value="sent">Sent</option><option value="failed">Failed</option><option value="skipped">Skipped</option></Select>}</Field>
      </Card>

      <div className="my-4 flex flex-wrap items-end gap-3">
        <Field label="Export" className="min-w-40">{(a) => <Select {...a} value={exp.scope} onChange={(e) => setExp({ ...exp, scope: e.target.value })}><option value="all">All contacts</option><option value="filtered">Current filter</option><option value="selected" disabled={selected.size === 0}>Selected ({selected.size})</option></Select>}</Field>
        <Field label="Format" className="min-w-28">{(a) => <Select {...a} value={exp.format} onChange={(e) => setExp({ ...exp, format: e.target.value })}><option value="xlsx">.xlsx</option><option value="json">.json</option></Select>}</Field>
        <Checkbox className="pb-2.5" label="Include delivery status" checked={exp.includeStatus} onChange={(e) => setExp({ ...exp, includeStatus: e.target.checked })} />
        <Button onClick={doExport}>Export</Button>
        {selected.size > 0 && <><Button variant="danger" onClick={bulkDelete}>Delete selected</Button><Button variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button></>}
        {data && data.total > items.length && data.total <= 500 && <Button variant="ghost" onClick={selectAllMatching}>Select all {data.total} matching</Button>}
      </div>
      <p className="mb-3 text-xs text-muted">“isSend” comes from your source data. “Delivery” is what this app actually did; sent means accepted by your email provider.</p>

      <Card className="overflow-hidden">
        {loading && !data ? <SkeletonRows /> : data && items.length === 0 && edit?.id !== "new" ? (
          <EmptyState icon={<UsersIcon />} title={filtered ? "No contacts match these filters" : "No recruiters yet"} description={filtered ? "Try clearing a filter or search." : "Add a recruiter manually or import a file to get started."}
            action={!filtered && <div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={startAdd}>Add recruiter</Button><Button onClick={() => setDlg("import")}>Import file</Button></div>} />
        ) : data && (
          <div className={t.wrap} tabIndex={0} aria-label="Recruiter contacts">
            <table className={t.table}>
              <thead className={t.thead}>
                <tr>
                  <th className={t.th}><input type="checkbox" className="size-4 accent-[var(--primary)]" aria-label="Select all on this page" checked={allOnPage} onChange={toggleAll} /></th>
                  {(["Name", "Company", "Email", "Role"] as const).map((c) => <th key={c} className={t.th} aria-sort={ariaSort(c)}><button type="button" className="font-semibold uppercase tracking-wide" onClick={() => sort(c)}>{c}{f.sort === c ? (f.order === "asc" ? " ▲" : " ▼") : ""}</button></th>)}
                  <th className={t.th}>Link</th><th className={t.th}>isSend</th>
                  <th className={t.th} aria-sort={ariaSort("deliveryStatus")}><button type="button" className="font-semibold uppercase tracking-wide" onClick={() => sort("deliveryStatus")}>Delivery{f.sort === "deliveryStatus" ? (f.order === "asc" ? " ▲" : " ▼") : ""}</button></th>
                  <th className={t.th}>Source</th><th className={t.th}>Actions</th>
                </tr>
              </thead>
              <tbody className={t.tbody}>
                {edit?.id === "new" && editorRow("new")}
                {items.map((c) => edit?.id === c.id ? editorRow(c.id) : (
                  <tr key={c.id} className={`${t.tr} ${selected.has(c.id) ? "bg-primary-soft/60" : "hover:bg-surface-muted/60"}`}>
                    <td data-label="Select" className={t.td}><input type="checkbox" className="size-4 accent-[var(--primary)]" aria-label={`Select ${c.Name}`} checked={selected.has(c.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} /></td>
                    <td data-label="Name" className={`${t.td} font-medium`}><Dash v={c.Name} /></td>
                    <td data-label="Company" className={t.td}><Dash v={c.Company} /></td>
                    <td data-label="Email" className={t.td}><Dash v={c.Email} /></td>
                    <td data-label="Role" className={t.td}><Dash v={c.Role} /></td>
                    <td data-label="Link" className={t.td}>{safeHref(c.Link) ? <a className="text-primary hover:underline" href={safeHref(c.Link)!} target="_blank" rel="noopener noreferrer">Open link</a> : "—"}</td>
                    <td data-label="isSend" className={t.td}><Dash v={c.isSend} /></td>
                    <td data-label="Delivery" className={t.td}><StatusBadge status={c.deliveryStatus} />{c.lastDelivery?.error && <div className="mt-1 text-xs text-muted">{c.lastDelivery.error}</div>}</td>
                    <td data-label="Source" className={`${t.td} text-muted`}>{sourceOf(c)}</td>
                    <td data-label="Actions" className={t.td}>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" aria-label={`Edit ${c.Name}`} onClick={() => { setEdit({ id: c.id, draft: { Name: c.Name, Company: c.Company, Email: c.Email, Role: c.Role, Link: c.Link, isSend: c.isSend } }); setRowErrors([]); }}>Edit</Button>
                        <Button size="sm" variant="danger" aria-label={`Delete ${c.Name}`} onClick={() => remove(c)}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Button onClick={() => { startAdd(); window.scrollTo({ top: 0 }); }}>+ Add row</Button>
        {data && <Pagination page={f.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setF({ ...f, page: p })} />}
      </div>

      {dlg === "import" && <ImportDialog onClose={() => setDlg(null)} onImported={() => void load()} />}
      {dlg === "send" && <SendDialog contactIds={[...selected]} onClose={() => setDlg(null)} onDone={() => void load()} />}
    </>
  );
}
