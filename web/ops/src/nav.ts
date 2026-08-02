/**
 * The operator back-office inherits eighteen screens. A flat row of eighteen is
 * the same mistake the old single-window build made, just at smaller scale — so
 * the nav is grouped by *what you are trying to do*, not by which entity a
 * screen happens to read.
 */
export interface OpsNavItem {
  to: string;
  label: string;
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
      { to: "/payments", label: "Payment 360°" },
      { to: "/payers", label: "Payer 360°" },
      { to: "/assessments", label: "Assessment 360°" },
      { to: "/uncertain", label: "UNCERTAIN queue" },
      { to: "/unapplied", label: "Unapplied receipts" },
    ],
  },
  {
    id: "reconcile",
    label: "Reconcile",
    items: [
      { to: "/recon", label: "Recon console" },
      { to: "/breaks", label: "Break register" },
    ],
  },
  {
    id: "exceptions",
    label: "Exceptions",
    items: [
      { to: "/refunds", label: "Refunds" },
      { to: "/disputes", label: "Disputes" },
      { to: "/approvals", label: "Approvals inbox" },
      { to: "/instruments", label: "Instrument clearing" },
    ],
  },
  {
    id: "money",
    label: "Money movement",
    items: [
      { to: "/sweep", label: "Sweep operations" },
      { to: "/bulk", label: "Bulk payments" },
    ],
  },
  {
    id: "assurance",
    label: "Assurance",
    items: [
      { to: "/controls", label: "Control assertions" },
      { to: "/audit", label: "Audit trail" },
      { to: "/overview", label: "Platform overview" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    items: [{ to: "/reports", label: "Operational reports" }],
  },
  {
    id: "admin",
    label: "Administration",
    items: [{ to: "/roles", label: "Roles" }],
  },
];
