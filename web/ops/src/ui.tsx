import type { ReactNode } from "react";

const TONE: Record<string, string> = {
  RESOLVED: "badge-good",
  CONFIRMED: "badge-good",
  CLEARED: "badge-good",
  APPROVED: "badge-good",
  PAID: "badge-good",
  ACTIVE: "badge-good",
  APPLIED: "badge-good",
  WON: "badge-good",
  OPEN: "badge-warn",
  PENDING: "badge-warn",
  PENDING_APPROVAL: "badge-warn",
  IN_CLEARING: "badge-warn",
  HELD_POST_DATED: "badge-warn",
  UNCERTAIN: "badge-warn",
  RECEIVED: "badge-warn",
  EVIDENCE_SUBMITTED: "badge-warn",
  RETURNED: "badge-bad",
  REVERSED: "badge-bad",
  FAILED: "badge-bad",
  REJECTED: "badge-bad",
  LOST: "badge-bad",
};

const SEVERITY: Record<string, string> = {
  CRITICAL: "bg-op-bad text-white",
  HIGH: "bg-op-bad/10 text-op-bad",
  MEDIUM: "bg-op-warn/10 text-op-warn",
  LOW: "bg-op-accent/10 text-op-accent",
  INFO: "bg-op-ink/[0.07] text-op-inkDim",
};

export function Status({ value }: { value: string | null }): JSX.Element {
  if (!value) return <span className="text-op-inkDim">—</span>;
  return <span className={`badge ${TONE[value] ?? "badge-neutral"}`}>{value.replace(/_/g, " ")}</span>;
}

export function Severity({ value }: { value: string }): JSX.Element {
  return <span className={`badge ${SEVERITY[value] ?? "badge-neutral"}`}>{value}</span>;
}

export function PageHead({ title, right, note }: { title: string; right?: ReactNode; note?: string }): JSX.Element {
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold">{title}</h1>
        {right}
      </div>
      {note && <p className="text-op-inkDim mt-1 max-w-4xl leading-snug">{note}</p>}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "good" | "bad" | "warn"; children: ReactNode }): JSX.Element {
  const cls =
    tone === "good"
      ? "border-op-good/40 bg-op-good/[0.05] text-op-good"
      : tone === "bad"
        ? "border-op-bad/40 bg-op-bad/[0.04] text-op-bad"
        : "border-op-warn/40 bg-op-warn/[0.06] text-op-warn";
  return <div className={`panel p-3 mb-3 ${cls}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-3 py-4 text-op-inkDim">{children}</div>;
}

/** Compact label/value pair for a detail strip. */
export function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
