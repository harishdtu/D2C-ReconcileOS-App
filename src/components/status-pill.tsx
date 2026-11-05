import { humanize } from "@/lib/format";

export default function StatusPill({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const tone =
    ["COMPLETED", "SETTLED", "RESOLVED", "PROCESSED", "RECOVERED"].includes(normalized)
      ? "status-success"
      : ["OPEN", "IN_REVIEW", "PROCESSING", "PARTIAL_MATCH", "REVIEW_REQUIRED", "PREVIEWED"].includes(normalized)
        ? "status-warning"
        : ["FAILED", "INVALID", "SHORT_PAID", "UNPAID_PAST_DUE", "FREIGHT_OVERCHARGED", "MISMATCH"].includes(normalized)
          ? "status-danger"
          : ["MAPPING_REQUIRED", "APPROVED", "RUNNING"].includes(normalized)
            ? "status-info"
            : "";
  return <span className={`status-pill ${tone}`}>{humanize(status)}</span>;
}
