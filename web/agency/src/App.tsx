import { NavLink, Outlet } from "react-router-dom";
import { HarnessBar } from "@shared/HarnessBar.js";
import { usePersona } from "@shared/PersonaContext.js";
import { displayName, roleLabel } from "@shared/personas.js";

/**
 * Agency portal shell.
 *
 * Everything below the harness bar belongs to *one* agency — the acting user's
 * own. There is no agency picker anywhere in this portal: you don't select your
 * tenant, you are one. That single constraint is most of what separates this
 * from the old single-window build, where an agency's own screens sat in the
 * same nav row as cross-agency reconciliation.
 */

const NAV: { to: string; label: string; group: string }[] = [
  { to: "/", label: "Position", group: "Collections" },
  { to: "/assessments", label: "Bills issued", group: "Collections" },
  { to: "/issue", label: "Issue a bill", group: "Collections" },
  { to: "/request-to-pay", label: "Request to pay", group: "Collections" },
  { to: "/treasury", label: "Treasury & scrolls", group: "Settlement" },
  { to: "/reports", label: "Statements", group: "Settlement" },
  { to: "/products", label: "Products", group: "Configuration" },
];

const GROUPS = ["Collections", "Settlement", "Configuration"];

export default function App(): JSX.Element {
  const { current, loading, error } = usePersona();

  return (
    <div className="min-h-screen flex flex-col">
      <HarnessBar portal="agency" />

      {/* Masthead — the agency's own identity, not the platform's. */}
      <header className="bg-ag-primary text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-end justify-between gap-6">
          <div>
            <div className="doc-title text-2xl leading-tight">
              {current?.agency_name ?? (loading ? "…" : "Agency Portal")}
            </div>
            <div className="text-xs text-white/70 mt-1 tracking-wide uppercase">
              Collection &amp; Treasury Portal
              {current?.agency_code ? ` · ${current.agency_code}` : ""}
            </div>
          </div>
          {current && (
            <div className="text-right text-xs text-white/80 leading-relaxed">
              <div className="font-semibold text-white">{displayName(current)}</div>
              <div>{current.roles.map(roleLabel).join(", ")}</div>
            </div>
          )}
        </div>

        <nav className="max-w-6xl mx-auto px-6 flex gap-6 border-t border-white/15">
          {GROUPS.map((group) => (
            <div key={group} className="flex items-center gap-1 py-0.5">
              <span className="text-[10px] uppercase tracking-wider text-white/40 mr-1">{group}</span>
              {NAV.filter((n) => n.group === group).map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === "/"}
                  className={({ isActive }) =>
                    `px-2.5 py-2 text-[13px] whitespace-nowrap border-b-2 -mb-px ${
                      isActive ? "border-ag-accent font-semibold text-white" : "border-transparent text-white/75 hover:text-white"
                    }`
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-7">
        {error ? (
          <div className="sheet p-4 border-ag-bad/40 bg-ag-bad/[0.04] text-ag-bad text-sm">
            Could not load the acting user: {error}
          </div>
        ) : loading ? (
          <div className="text-ag-inkDim text-sm">Loading…</div>
        ) : (
          <Outlet />
        )}
      </main>

      <footer className="border-t border-ag-rule bg-ag-panelAlt">
        <div className="max-w-6xl mx-auto px-6 py-3 text-[11px] text-ag-inkDim">
          System-generated. All figures are computed from the platform ledger at the demonstration business date.
        </div>
      </footer>
    </div>
  );
}
