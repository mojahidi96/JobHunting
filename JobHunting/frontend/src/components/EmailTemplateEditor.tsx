import { PLACEHOLDERS, type EmailTemplate } from "../types/api";

interface Props {
  template: EmailTemplate;
  onChange: (t: EmailTemplate) => void;
  onReset: () => void;
}

export function EmailTemplateEditor({ template, onChange, onReset }: Props) {
  return (
    <section className="panel" aria-labelledby="tpl-h">
      <div className="panel-head">
        <h2 id="tpl-h">Email template</h2>
        <button type="button" onClick={onReset}>Reset to default</button>
      </div>
      <label>
        Subject
        <input type="text" value={template.subject} onChange={(e) => onChange({ ...template, subject: e.target.value })} />
      </label>
      <label>
        Body (HTML)
        <textarea rows={14} spellCheck={false} value={template.html} onChange={(e) => onChange({ ...template, html: e.target.value })} />
      </label>
      <details className="placeholders" open>
        <summary>Supported placeholders</summary>
        <ul aria-label="Supported placeholders">
          {PLACEHOLDERS.map(([name, desc]) => (
            <li key={name}>
              <code>{`{{${name}}}`}</code> <span className="muted">{desc}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
