import type { PreviewItem, Recruiter } from "../types/api";

interface Props {
  items: PreviewItem[] | null;
  recruiters: Map<string, Recruiter>;
  activeId: string | null;
  onActiveChange: (id: string) => void;
  stale: boolean;
}

export function EmailPreview({ items, recruiters, activeId, onActiveChange, stale }: Props) {
  if (!items || items.length === 0) return null;
  const active = items.find((i) => i.recruiterId === activeId) ?? items[0];
  return (
    <section className="panel" aria-labelledby="prev-h">
      <h2 id="prev-h">Preview <span className="tag">Preview only — nothing has been sent</span></h2>
      {stale && <p className="notice" role="status">The template or selection changed since this preview. Preview again to refresh.</p>}
      {items.length > 1 && (
        <label>
          Preview as
          <select value={active.recruiterId} onChange={(e) => onActiveChange(e.target.value)}>
            {items.map((i) => (
              <option key={i.recruiterId} value={i.recruiterId}>
                {recruiters.get(i.recruiterId)?.Name || i.to}
              </option>
            ))}
          </select>
        </label>
      )}
      <dl className="meta">
        <dt>To</dt><dd>{active.to || "—"}</dd>
        <dt>Subject</dt><dd>{active.subject}</dd>
      </dl>
      {active.warnings.length > 0 && (
        <ul className="warnings" aria-label="Warnings">
          {active.warnings.map((w) => <li key={w}>⚠ {w}</li>)}
        </ul>
      )}
      <iframe title="Email preview" sandbox="" srcDoc={active.html} className="preview-frame" />
    </section>
  );
}
