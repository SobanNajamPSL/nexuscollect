import { NavLink, Outlet } from "react-router-dom";

const NAV = [
  { to: "/", label: "1. Citizen Payment" },
  { to: "/verify", label: "2. Verify Receipt" },
  { to: "/breaks", label: "3. Break Register" },
  { to: "/instruments", label: "4. Instrument Register" },
  { to: "/dashboard", label: "5. Agency Dashboard" },
  { to: "/controls", label: "6. Control Assertions" },
];

// §22.1's back-office screens beyond the 6 demo-critical ones above — a
// second, less prominent row, since the demo's own priority order (CLAUDE.md)
// puts citizen journey clarity and head-wise reporting first.
const OPS_NAV = [
  { to: "/ops/payments", label: "Payment 360°" },
  { to: "/ops/assessments", label: "Assessment 360°" },
  { to: "/ops/payers", label: "Payer 360°" },
  { to: "/ops/unapplied", label: "Unapplied Queue" },
  { to: "/ops/uncertain", label: "UNCERTAIN Queue" },
  { to: "/ops/teller", label: "Teller / Till" },
  { to: "/ops/settlement", label: "Settlement & Sweep" },
  { to: "/ops/approvals", label: "Approvals Inbox" },
  { to: "/ops/agencies", label: "Agency Config" },
  { to: "/ops/recon-console", label: "Recon Console" },
  { to: "/ops/reports", label: "Report Centre" },
  { to: "/ops/audit", label: "Audit Explorer" },
  { to: "/ops/rtp", label: "Request to Pay" },
  { to: "/ops/refunds", label: "Refunds" },
  { to: "/ops/bulk-payments", label: "Bulk Payments" },
];

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gov-primary text-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <div className="font-semibold text-lg">NexusCollect</div>
            <div className="text-xs text-white/70">Person-to-Government Collection Platform — Demo</div>
          </div>
          <div className="text-xs bg-white/10 rounded px-2 py-1">Demo clock: 2026-07-30 (Asia/Karachi)</div>
        </div>
        <nav className="max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `px-3 py-2 text-sm whitespace-nowrap border-b-2 ${isActive ? "border-white font-semibold" : "border-transparent text-white/80 hover:text-white"}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="bg-gov-primaryDark/90 text-white/90">
        <nav className="max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {OPS_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `px-2.5 py-1.5 text-xs whitespace-nowrap border-b-2 ${isActive ? "border-white font-semibold text-white" : "border-transparent text-white/60 hover:text-white"}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">
        <Outlet />
      </main>
      <footer className="text-center text-xs text-gov-ink/50 py-4">
        This is a system-generated demonstration build. All figures are drawn from real seeded data.
      </footer>
    </div>
  );
}
