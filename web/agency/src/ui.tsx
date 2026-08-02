import type { ReactNode } from "react";

/** Assessment/RtP/scroll statuses share one tone vocabulary across the portal. */
const TONE: Record<string, string> = {
  SETTLED: "badge-good",
  ACTIVE: "badge-good",
  APPROVED: "badge-good",
  FULFILLED: "badge-good",
  ACKNOWLEDGED: "badge-good",
  CLOSED: "badge-good",
  ISSUED: "badge-neutral",
  DRAFT: "badge-neutral",
  CREATED: "badge-neutral",
  SENT: "badge-neutral",
  DELIVERED: "badge-neutral",
  PRESENTED: "badge-neutral",
  OPEN: "badge-neutral",
  GENERATED: "badge-neutral",
  PENDING_APPROVAL: "badge-warn",
  PARTIALLY_PAID: "badge-warn",
  ACCEPTED_FUTURE_DATED: "badge-warn",
  PENDING: "badge-warn",
  TRANSMITTED: "badge-warn",
  OVERDUE: "badge-bad",
  EXPIRED: "badge-bad",
  CANCELLED: "badge-bad",
  DECLINED: "badge-bad",
  UNDELIVERABLE: "badge-bad",
  REJECTED: "badge-bad",
  WRITTEN_OFF: "badge-bad",
};

export function Status({ value }: { value: string | null }): JSX.Element {
  if (!value) return <span className="text-ag-inkDim">—</span>;
  return <span className={`badge ${TONE[value] ?? "badge-neutral"}`}>{value.replace(/_/g, " ")}</span>;
}

export function PageHead({ title, right, note }: { title: string; right?: ReactNode; note?: string }): JSX.Element {
  return (
    <div className="border-b border-ag-rule pb-3 mb-5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="doc-title text-xl">{title}</h1>
        {right}
      </div>
      {note && <p className="text-[12px] text-ag-inkDim mt-1.5 max-w-3xl leading-relaxed">{note}</p>}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "good" | "bad" | "warn"; children: ReactNode }): JSX.Element {
  const cls =
    tone === "good"
      ? "border-ag-good/40 bg-ag-good/[0.05] text-ag-good"
      : tone === "bad"
        ? "border-ag-bad/40 bg-ag-bad/[0.04] text-ag-bad"
        : "border-ag-warn/40 bg-ag-warn/[0.05] text-ag-warn";
  return <div className={`sheet p-3 text-sm ${cls}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-4 py-6 text-sm text-ag-inkDim">{children}</div>;
}
