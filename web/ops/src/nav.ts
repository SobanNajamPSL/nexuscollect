/**
 * The operator back-office inherits roughly eighteen screens. A flat row of
 * eighteen is the same mistake the old single-window build made, just at smaller
 * scale — so the nav is grouped by *what you are trying to do*, not by which
 * entity a screen happens to read.
 *
 * `built: false` entries are screens migrating here in a later step; they render
 * a labelled placeholder rather than a blank page, so nothing in the portal is
 * silently missing.
 */
export interface OpsNavItem {
  to: string;
  label: string;
  built: boolean;
  note?: string;
}

export interface OpsNavGroup {
  id: string;
  label: string;
  items: OpsNavItem[];
}

export const OPS_NAV: OpsNavGroup[] = [
  {
    id: "investigate",
    label: "Investigate",
    items: [
      { to: "/payments", label: "Payment 360°", built: false, note: "Trace any payment: allocations, journal entries, receipt, recon status, and the recall action." },
      { to: "/payers", label: "Payer 360°", built: false, note: "One payer across every agency — the cross-tenant view an agency deliberately cannot see." },
      { to: "/assessments", label: "Assessment 360°", built: false, note: "One bill's full history: versions, line items, allocations, notifications." },
      { to: "/uncertain", label: "UNCERTAIN queue", built: false, note: "Payments whose success could not be determined at capture. Never shown to a payer as failure; resolved here on real evidence." },
      { to: "/unapplied", label: "Unapplied receipts", built: false, note: "Money genuinely received but not yet matched to a bill. Held, never rejected." },
    ],
  },
  {
    id: "reconcile",
    label: "Reconcile",
    items: [
      { to: "/recon", label: "Recon console", built: false, note: "Run the day's reconciliation against bank, switch and rail files." },
      { to: "/breaks", label: "Break register", built: false, note: "Investigate, propose and approve break resolutions under maker-checker." },
    ],
  },
  {
    id: "exceptions",
    label: "Exceptions",
    items: [
      { to: "/refunds", label: "Refunds", built: false, note: "Create, approve as a second user, and pay. Beneficiary always defaults to the original debit account." },
      { to: "/disputes", label: "Disputes", built: false, note: "Card chargebacks: evidence bundle, then won or lost with liability assigned." },
      { to: "/approvals", label: "Approvals inbox", built: false, note: "Everything awaiting a second pair of eyes, in one queue." },
      { to: "/instruments", label: "Instrument clearing", built: false, note: "Cheque clearing and returns — including the dishonour cascade. Lodgement happens at the counter, in the field portal." },
    ],
  },
  {
    id: "money",
    label: "Money movement",
    items: [
      { to: "/sweep", label: "Sweep operations", built: false, note: "Run sweeps and generate scrolls. The agency's own view of its scrolls lives in the agency portal." },
      { to: "/bulk", label: "Bulk payments", built: false, note: "Corporate file intake. One bad row rejects the whole file by default." },
    ],
  },
  {
    id: "assurance",
    label: "Assurance",
    items: [
      { to: "/controls", label: "Control assertions", built: false, note: "The five reperformance checks. Read-only here — the tamper action belongs to the harness, not to any operator." },
      { to: "/audit", label: "Audit trail", built: false, note: "Who did what, when, on its own hash chain — separate from the ledger's." },
      { to: "/executive", label: "Platform overview", built: false, note: "Collections trend, channel mix, reconciliation health across every agency." },
    ],
  },
  {
    id: "admin",
    label: "Administration",
    items: [
      { to: "/roles", label: "Roles", built: false, note: "The twelve named roles and who holds them." },
    ],
  },
];

export function findNavItem(pathname: string): OpsNavItem | undefined {
  for (const g of OPS_NAV) {
    const hit = g.items.find((i) => i.to === pathname);
    if (hit) return hit;
  }
  return undefined;
}
