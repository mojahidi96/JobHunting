import { useState } from "react";
import { api } from "../api";
import { ErrorAlert, fmtDate, useLoad } from "../components/common";
import { useConfirm, usePrompt } from "../components/confirm";
import { FileIcon } from "../components/icons";
import { TemplateEditor } from "../components/TemplateEditor";
import { Badge, Button, Card, EmptyState, PageHeader, SkeletonRows, useToast } from "../components/ui";
import type { PlaceholderConfig, Template } from "../types";

type NewTemplate = { name: string; subject: string; html: string; placeholderConfig: PlaceholderConfig; starterKey?: string };

const uniqueName = (base: string, taken: string[]) => {
  const names = new Set(taken.map((n) => n.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
};

export function TemplatesPage() {
  const { data, error, loading, reload } = useLoad(() => api.templates(), []);
  const [editing, setEditing] = useState<Template | NewTemplate | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();

  async function act(fn: () => Promise<unknown>, ok: string) { setActionError(null); try { await fn(); await reload(); toast("success", ok); } catch (e) { setActionError(e); } }

  /** "New template" opens the editor pre-filled with the sample template. Edit it, or clear it and write your own. */
  async function newTemplate() {
    setActionError(null);
    try {
      const sample = (await api.starters()).items.find((s) => s.key === "generic");
      setEditing({
        name: uniqueName("My template", data?.items.map((t) => t.name) ?? []),
        subject: sample?.subject ?? "", html: sample?.html ?? "", placeholderConfig: sample?.placeholderConfig ?? {},
        starterKey: sample?.key,
      });
    } catch (e) { setActionError(e); }
  }

  async function rename(t: Template) {
    const n = await prompt({ title: "Rename template", label: "Template name", initialValue: t.name, confirmLabel: "Rename" });
    if (n && n !== t.name) void act(() => api.updateTemplate(t.id, { name: n }), "Template renamed.");
  }
  async function remove(t: Template) {
    const ok = await confirm({ title: "Delete template?", message: <>“{t.name}” will be permanently deleted. Past email history that used it is not affected.</>, confirmLabel: "Delete template", tone: "danger" });
    if (ok) void act(() => api.deleteTemplate(t.id), "Template deleted.");
  }

  const isNew = (e: Template | NewTemplate): e is NewTemplate => !("id" in e);
  return (
    <>
      <PageHeader title="Email Templates" description={<>Full HTML subject and body with placeholders such as <code>{"{{firstName}}"}</code>. Changing a template creates a new version that must be reviewed before sending.</>}
        actions={<Button variant="primary" onClick={newTemplate}>New template</Button>} />
      <ErrorAlert error={error} onRetry={reload} />
      <ErrorAlert error={actionError} />
      {loading && !data && <Card><SkeletonRows rows={3} /></Card>}
      {data && (data.items.length === 0 ? (
        <Card><EmptyState icon={<FileIcon />} title="No templates yet" description="Create one from the sample template and edit it to fit you." action={<Button variant="primary" onClick={newTemplate}>New template</Button>} /></Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {data.items.map((t) => (
            <li key={t.id}>
              <Card className="flex h-full flex-col gap-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="flex items-center gap-2 font-semibold">{t.name}{t.isDefault && <Badge tone="primary">Default</Badge>}</h2>
                  <Badge tone={t.reviewed ? "success" : "warning"}>{t.reviewed ? "✓ Reviewed" : "Needs review"} · v{t.version}</Badge>
                </div>
                <p className="line-clamp-2 text-sm text-muted">Subject: {t.subject}</p>
                <p className="text-xs text-muted">Updated {fmtDate(t.updatedAt)}</p>
                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="primary" onClick={() => setEditing(t)}>Edit</Button>
                  <Button size="sm" onClick={() => act(() => api.duplicateTemplate(t.id), "Template duplicated.")}>Duplicate</Button>
                  {!t.isDefault && <Button size="sm" onClick={() => act(() => api.updateTemplate(t.id, { isDefault: true }), "Default template updated.")}>Make default</Button>}
                  <Button size="sm" onClick={() => void rename(t)}>Rename</Button>
                  <Button size="sm" variant="danger" onClick={() => void remove(t)}>Delete</Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ))}
      {editing && (
        <TemplateEditor template={isNew(editing) ? null : editing} initial={isNew(editing) ? editing : undefined}
          onSaved={() => void reload()} onClose={() => { setEditing(null); void reload(); }} />
      )}
    </>
  );
}
