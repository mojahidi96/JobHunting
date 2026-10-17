import type { DeliveryStatus } from "../types/api";

export type IsSendFilter = "all" | "blank" | "no" | "other";
export interface Filters {
  search: string;
  status: DeliveryStatus | "all";
  isSend: IsSendFilter;
}

export function RecruiterFilters({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  return (
    <div className="filters" role="search">
      <label>
        Search
        <input
          type="search"
          placeholder="Name, company, email or role"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />
      </label>
      <label>
        Delivery status
        <select value={filters.status} onChange={(e) => onChange({ ...filters, status: e.target.value as Filters["status"] })}>
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </select>
      </label>
      <label>
        isSend column
        <select value={filters.isSend} onChange={(e) => onChange({ ...filters, isSend: e.target.value as IsSendFilter })}>
          <option value="all">All</option>
          <option value="blank">Blank</option>
          <option value="no">no</option>
          <option value="other">Other values</option>
        </select>
      </label>
    </div>
  );
}

export function applyFilters<T extends { Name: string; Company: string; Email: string; Role: string; isSend: string | null; status: DeliveryStatus }>(
  items: T[],
  f: Filters,
): T[] {
  const q = f.search.trim().toLowerCase();
  return items.filter((r) => {
    if (q && ![r.Name, r.Company, r.Email, r.Role].some((v) => v.toLowerCase().includes(q))) return false;
    if (f.status !== "all" && r.status !== f.status) return false;
    const v = r.isSend?.toLowerCase() ?? null;
    if (f.isSend === "blank" && v !== null) return false;
    if (f.isSend === "no" && v !== "no") return false;
    if (f.isSend === "other" && (v === null || v === "no")) return false;
    return true;
  });
}
