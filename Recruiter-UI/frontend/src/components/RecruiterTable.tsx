import { useMemo, useState } from "react";
import type { Recruiter } from "../types/api";
import { StatusBadge } from "./StatusBadge";

type SortKey = "Name" | "Company" | "Email" | "Role" | "Link" | "isSend" | "status";
const COLUMNS: SortKey[] = ["Name", "Company", "Email", "Role", "Link", "isSend", "status"];
const HEADINGS: Record<SortKey, string> = {
  Name: "Name", Company: "Company", Email: "Email", Role: "Role", Link: "Link", isSend: "isSend", status: "Delivery status",
};

function safeUrl(v: string | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const dash = <span aria-label="empty">—</span>;

interface Props {
  rows: Recruiter[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectVisible: () => void;
  onClear: () => void;
}

export function RecruiterTable({ rows, selected, onToggle, onSelectVisible, onClear }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => (a[sort.key] ?? "").localeCompare(b[sort.key] ?? "", undefined, { sensitivity: "base" }) * sort.dir);
  }, [rows, sort]);
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));

  return (
    <div>
      <div className="toolbar">
        <button type="button" onClick={onSelectVisible} disabled={rows.length === 0 || allVisibleSelected}>
          Select visible ({rows.length})
        </button>
        <button type="button" onClick={onClear} disabled={selected.size === 0}>
          Clear selection
        </button>
        <span aria-live="polite">{selected.size} selected</span>
      </div>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Recruiters from the workbook</caption>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Select</span></th>
              {COLUMNS.map((c) => (
                <th
                  key={c}
                  scope="col"
                  aria-sort={sort?.key === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                >
                  <button type="button" className="th-btn" onClick={() => toggleSort(c)}>
                    {HEADINGS[c]} <span aria-hidden="true">{sort?.key === c ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
                  </button>
                </th>
              ))}
              <th scope="col">Row</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const url = safeUrl(r.Link);
              return (
                <tr key={r.id} className={selected.has(r.id) ? "selected" : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.Name || r.Email || r.id}`}
                      checked={selected.has(r.id)}
                      onChange={() => onToggle(r.id)}
                    />
                  </td>
                  <td>{r.Name || dash}</td>
                  <td>{r.Company || dash}</td>
                  <td>{r.Email || dash}</td>
                  <td>{r.Role || dash}</td>
                  <td>
                    {r.Link ? (url ? <a href={url} target="_blank" rel="noopener noreferrer">{r.Link}</a> : r.Link) : dash}
                  </td>
                  <td>{r.isSend ?? dash}</td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.lastError && <div className="muted small">{r.lastError}</div>}
                  </td>
                  <td className="muted">{r.rowNumber}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
