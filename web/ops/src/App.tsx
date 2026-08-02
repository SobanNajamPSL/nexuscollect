import { NavLink, Outlet } from "react-router-dom";
import { HarnessBar } from "@shared/HarnessBar.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { displayName, roleLabel } from "@shared/personas.js";
import { OPS_NAV } from "./nav.js";

/**
 * Operator back-office shell.
 *
 * This is the platform operator's own console — cross-agency by nature, which is
 * exactly why it must be a separate surface from the agency portal rather than a
 * second nav row beside it. Reconciliation spans tenants; an agency's view of
 * itself must not.
 *
 * A left rail rather than a top bar: eighteen destinations in six workflow
 * groups don't fit horizontally, and staff navigate this by group all day.
 */
export default function App(): JSX.Element {
  const { current, loading, error } = usePersona();
  const clock = useDemoClock();

  return (
    <div className="min-h-screen flex flex-col">
      <HarnessBar portal="ops" />

      <div className="bg-op-primaryDark text-white">
        <div className="px-4 py-2 flex items-center justify-between gap-6">
          <div className="flex items-baseline gap-3">
            <span className="font-semibold tracking-tight">NexusCollect</span>
            <span className="text-[11px] uppercase tracking-widest text-white/55">Operations Console</span>
          </div>
          <div className="flex items-center gap-5 text-[11px] text-white/70">
            <span>
              Business date <span className="font-mono text-white">{businessDate(clock) ?? "…"}</span>
            </span>
            {current && (
              <span>
                <span className="text-white font-semibold">{displayName(current)}</span>
                {" · "}
                {current.roles.map(roleLabel).join(", ")}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Grouped left rail. */}
        <aside className="w-52 shrink-0 border-r border-op-rule bg-op-panel overflow-y-auto">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `block px-3 py-2 text-[13px] font-semibold border-b border-op-rule ${
                isActive ? "bg-op-primary/[0.08] text-op-primary" : "text-op-ink hover:bg-op-panelAlt"
              }`
            }
          >
            Today
          </NavLink>

          {OPS_NAV.map((group) => (
            <div key={group.id} className="border-b border-op-rule/70 py-1.5">
              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-op-inkDim">
                {group.label}
              </div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `block px-3 py-1 text-[13px] ${
                      isActive
                        ? "bg-op-primary/[0.08] text-op-primary font-semibold"
                        : "text-op-ink hover:bg-op-panelAlt"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </aside>

        <main className="flex-1 min-w-0 overflow-x-auto px-5 py-4">
          {error ? (
            <div className="panel p-3 border-op-bad/40 bg-op-bad/[0.04] text-op-bad">
              Could not load the acting user: {error}
            </div>
          ) : loading ? (
            <div className="text-op-inkDim">Loading…</div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
