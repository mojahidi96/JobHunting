import type { DeliveryStatus } from "../types/api";

const LABEL: Record<DeliveryStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
};
const ICON: Record<DeliveryStatus, string> = { pending: "○", sent: "✓", failed: "✕", skipped: "–" };

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <span aria-hidden="true">{ICON[status]}</span> {LABEL[status]}
    </span>
  );
}
