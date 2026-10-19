import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { BUILTIN, CONTACT_FIELDS, PROFILE_FIELDS, SOURCE_LABEL, tokensIn } from "../placeholders";
import type { Contact, FieldConfig, FieldSource, PlaceholderConfig, PreviewResponse, Template } from "../types";
import { Alert, ErrorAlert, Modal, PreviewFrame } from "./common";
import { useConfirm } from "./confirm";
import { Badge, Button, Checkbox, Field, Input, Select, Textarea, useToast } from "./ui";

interface Props {
  template: Template | null;
  initial?: { name: string; subject: string; html: string; placeholderConfig: PlaceholderConfig; starterKey?: string };
  onSaved: (t: Template) => void;
  onClose: () => void;
}

export function TemplateEditor({ template, initial, onSaved, onClose }: Props) {
  const base = template ?? initial ?? { name: "", subject: "", html: "", placeholderConfig: {} as PlaceholderConfig };
  const [saved, setSaved] = useState<Template | null>(template);
  const [name, setName] = useState(base.name);
  const [subject, setSubject] = useState(base.subject);
  const [html, setHtml] = useState(base.html);
  const [config, setConfig] = useState<PlaceholderConfig>(base.placeholderConfig ?? {});
  const [snapshot, setSnapshot] = useState(JSON.stringify([base.name, base.subject, base.html, base.placeholderConfig ?? {}]));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const [perSend, setPerSend] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<"subject" | "html">("html");
  const toast = useToast();
  const confirm = useConfirm();

  const dirty = JSON.stringify([name, subject, html, config]) !== snapshot;
  const used = useMemo(() => tokensIn(subject, html), [subject, html]);

  useEffect(() => { api.contacts({ pageSize: 50, sort: "Name", order: "asc" }).then((r) => { setContacts(r.items); setContactId(r.items[0]?.id ?? ""); }).catch(() => undefined); }, []);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const requestClose = async () => {
    if (!dirty || await confirm({ title: "Discard unsaved changes?", message: "Your edits to this template haven't been saved and will be lost.", confirmLabel: "Discard changes", cancelLabel: "Keep editing" })) onClose();
  };

  function insert(token: string) {
    const el = lastFocus.current === "subject" ? subjectRef.current : htmlRef.current;
    const text = `{{${token}}}`;
    if (!el) return;
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    const next = el.value.slice(0, s) + text + el.value.slice(e);
    if (el === subjectRef.current) setSubject(next); else setHtml(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + text.length, s + text.length); });
  }

  function setSource(key: string, source: FieldSource | "default") {
    setConfig((c) => {
      const n = { ...c };
      if (source === "default") { delete n[key]; return n; }
      const f: FieldConfig = { source };
      if (source === "contact") f.field = CONTACT_FIELDS.includes(key as never) ? key : "Name";
      if (source === "profile") f.field = PROFILE_FIELDS.includes(key as never) ? key : "SENDER_NAME";
      if (source === "manual" || source === "static") f.value = n[key]?.value ?? "";
      if (n[key]?.allowEmpty) f.allowEmpty = true;
      n[key] = f;
      return n;
    });
  }
  const patchCfg = (key: string, p: Partial<FieldConfig>) => setConfig((c) => ({ ...c, [key]: { ...(c[key] ?? BUILTIN[key]), ...p } }));

  async function save(): Promise<Template | null> {
    setBusy(true); setError(null);
    try {
      const body = { name: name.trim(), subject, html, placeholderConfig: config };
      const { item } = saved ? await api.updateTemplate(saved.id, body) : await api.createTemplate({ ...body, starterKey: initial?.starterKey });
      setSaved(item); setSnapshot(JSON.stringify([item.name, item.subject, item.html, item.placeholderConfig]));
      setConfig(item.placeholderConfig); setReviewed(false);
      toast("success", `Saved (version ${item.version}).`);
      onSaved(item);
      return item;
    } catch (e) { setError(e); return null; } finally { setBusy(false); }
  }

  async function runPreview() {
    if (!contactId) return;
    setPreviewing(true); setError(null);
    try { setPreview(await api.preview({ template: { subject, html, placeholderConfig: config }, contactIds: [contactId], perSendValues: perSend })); }
    catch (e) { setError(e); } finally { setPreviewing(false); }
  }

  async function reset() {
    if (!(await confirm({ title: "Reset to starter?", message: "This replaces the subject, body and placeholder settings with the starter content. Your edits will be lost.", confirmLabel: "Reset template", tone: "danger" }))) return;
    if (saved?.starterKey) {
      setBusy(true); setError(null);
      try {
        const { item } = await api.resetTemplate(saved.id);
        setSaved(item); setName(item.name); setSubject(item.subject); setHtml(item.html); setConfig(item.placeholderConfig);
        setSnapshot(JSON.stringify([item.name, item.subject, item.html, item.placeholderConfig])); onSaved(item); toast("success", "Reset to starter.");
      } catch (e) { setError(e); } finally { setBusy(false); }
    } else if (initial) { setSubject(initial.subject); setHtml(initial.html); setConfig(initial.placeholderConfig); }
  }

  async function confirmReview() {
    if (!saved || dirty) return;
    setBusy(true); setError(null);
    try { const { item } = await api.reviewTemplate(saved.id, saved.version); setSaved(item); onSaved(item); toast("success", "Template review confirmed."); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }

  const canReset = !!(saved?.starterKey || initial);
  const perSendKeys = used.filter((k) => (config[k] ?? BUILTIN[k])?.source === "perSend");

  return (
    <Modal title={saved ? "Update email template" : "New email template"} size="lg" onClose={() => void requestClose()} footer={<>
      {canReset && <Button onClick={reset} disabled={busy}>Reset to starter</Button>}
      <Button onClick={() => void requestClose()}>{dirty ? "Cancel" : "Close"}</Button>
      <Button variant="primary" onClick={save} loading={busy} disabled={!name.trim() || !subject.trim() || !html.trim() || (!dirty && !!saved)}>Save</Button>
    </>}>
      <ErrorAlert error={error} />
      {dirty && <p className="mb-3 text-xs font-semibold text-warning" role="status">● Unsaved changes</p>}
      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          <Field label="Template name">{(a) => <Input {...a} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Subject">{(a) => <Input {...a} ref={subjectRef} value={subject} maxLength={300} onFocus={() => (lastFocus.current = "subject")} onChange={(e) => setSubject(e.target.value)} />}</Field>
          <Field label="HTML body">{(a) => <Textarea {...a} ref={htmlRef} rows={14} className="font-mono text-xs" value={html} onFocus={() => (lastFocus.current = "html")} onChange={(e) => setHtml(e.target.value)} spellCheck={false} />}</Field>
          <details open className="rounded-lg border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Placeholders. Click to insert at the cursor</summary>
            <div className="border-t border-border p-3">
              <div className="flex flex-wrap gap-1.5">
                {[...CONTACT_FIELDS, ...PROFILE_FIELDS, ...Object.keys(config).filter((k) => !BUILTIN[k])].map((k) => (
                  <button key={k} type="button" onClick={() => insert(k)} className="min-h-8 rounded-md border border-border bg-surface-muted px-2 font-mono text-xs hover:bg-primary-soft hover:text-primary">{`{{${k}}}`}</button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">Add your own, e.g. <code>{"{{AVAILABILITY}}"}</code>: type it in the template, then choose where its value comes from below.</p>
            </div>
          </details>
          {used.length > 0 && (
            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium">Where each value comes from</legend>
              <div className="space-y-2">
                {used.map((k) => {
                  const cfg = config[k]; const eff = cfg ?? BUILTIN[k];
                  return (
                    <div key={k} className="flex flex-wrap items-center gap-2">
                      <code className="w-40 shrink-0 truncate" title={k}>{`{{${k}}}`}</code>
                      <Select className="min-w-40 flex-1" aria-label={`Source for ${k}`} value={cfg ? cfg.source : BUILTIN[k] ? "default" : ""} onChange={(e) => setSource(k, (e.target.value || "default") as FieldSource | "default")}>
                        {BUILTIN[k] ? <option value="default">Default ({SOURCE_LABEL[BUILTIN[k].source]})</option> : <option value="">⚠ Choose a source…</option>}
                        {(Object.keys(SOURCE_LABEL) as FieldSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                      </Select>
                      {cfg?.source === "contact" && <Select className="w-36" aria-label={`Contact field for ${k}`} value={cfg.field} onChange={(e) => patchCfg(k, { field: e.target.value })}>{CONTACT_FIELDS.map((f) => <option key={f}>{f}</option>)}</Select>}
                      {cfg?.source === "profile" && <Select className="w-44" aria-label={`Profile field for ${k}`} value={cfg.field} onChange={(e) => patchCfg(k, { field: e.target.value })}>{PROFILE_FIELDS.map((f) => <option key={f}>{f}</option>)}</Select>}
                      {(cfg?.source === "manual" || cfg?.source === "static") && <Input className="min-w-40 flex-1" aria-label={`Value for ${k}`} value={cfg.value ?? ""} maxLength={2000} placeholder="Text to insert" onChange={(e) => patchCfg(k, { value: e.target.value })} />}
                      {eff && <Checkbox label="allow empty" checked={!!eff.allowEmpty} onChange={(e) => patchCfg(k, { allowEmpty: e.target.checked })} />}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted">Precedence: this template's setting → the built-in default. Empty values block sending unless “allow empty” is ticked.</p>
            </fieldset>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="font-semibold">Preview</h3>
          {contacts.length === 0 ? <p className="text-sm text-muted">Add a recruiter contact to preview this template with real data. Previews never send email.</p> : (
            <>
              <Field label="Preview with contact">{(a) => <Select {...a} value={contactId} onChange={(e) => setContactId(e.target.value)}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.Name} — {c.Company}</option>)}</Select>}</Field>
              {perSendKeys.map((k) => <Field key={k} label={`{{${k}}} (asked at send time)`}>{(a) => <Input {...a} value={perSend[k] ?? ""} onChange={(e) => setPerSend({ ...perSend, [k]: e.target.value })} />}</Field>)}
              <Button onClick={runPreview} loading={previewing} disabled={!subject.trim() || !html.trim()}>{previewing ? "Rendering…" : "Preview"}</Button>
              {preview && (
                <div className="space-y-2">
                  <p className="text-sm"><strong>Subject:</strong> {preview.items[0]?.subject}</p>
                  {preview.problems.filter((p) => p.code === "PLACEHOLDERS_UNRESOLVED").map((p) => <Alert key={p.code} kind="warn"><strong>Unresolved:</strong><ul>{p.details.map((d, i) => <li key={i}>{d}</li>)}</ul></Alert>)}
                  <PreviewFrame html={preview.items[0]?.html ?? ""} />
                  <p className="text-xs text-muted">Rendered in a sandboxed frame. Nothing was sent.</p>
                </div>
              )}
            </>
          )}
          <div className="rounded-lg border border-border bg-surface-muted p-4">
            <h3 className="flex items-center gap-2 font-semibold">First-use review {saved && <Badge tone={saved.reviewed ? "success" : "warning"}>{saved.reviewed ? `✓ v${saved.version} reviewed` : `v${saved.version} not reviewed`}</Badge>}</h3>
            <p className="mt-1 text-sm text-muted">Before the first real send, confirm you reviewed this version: your name, experience, skills, contact details, links and wording.</p>
            {saved && !saved.reviewed && (
              <div className="mt-3 space-y-3">
                <Checkbox label="I have reviewed this template and it is accurate and personalised." checked={reviewed} disabled={dirty} onChange={(e) => setReviewed(e.target.checked)} />
                {dirty && <p className="text-xs text-muted">Save your changes first.</p>}
                <Button variant="primary" disabled={!reviewed || dirty || busy} onClick={confirmReview}>Confirm review</Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
