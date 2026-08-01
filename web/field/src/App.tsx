import { NavLink, Outlet } from "react-router-dom";
import { HarnessBar } from "@shared/HarnessBar.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { displayName, roleLabel } from "@shared/personas.js";

/**
 * Field collection shell — a bank counter or a neighbourhood shop.
 *
 * Two devices share this portal: a teller's workstation and an agent's phone.
 * Both are used standing up, often in poor light, usually with someone waiting.
 * Hence very large targets, few destinations, and amounts readable at arm's
 * length.
 *
 * Worth stating plainly, because it's the distinction the whole channel turns
 * on: an agent is not a branch. A citizen's payment is final the moment cash is
 * accepted here — what the agent then owes the operator is a separate, parallel
 * reconciliation, never conflated with whether the citizen's bill is settled.
 */
const NAV = [
  { to: "/", label: "Take a payment" },
  { to: "/instrument", label: "Lodge a cheque" },
  { to: "/till", label: "Close the till" },
  { to: "/agent", label: "Agent float" },
];

export default function App(): JSX.Element {
  const { current, loading, error } = usePersona();
  const clock = useDemoClock();

  return (
    <div className="min-h-screen flex flex-col">
      <HarnessBar portal="field" />

      <header className="bg-fd-ink text-white">
        <div className="px-5 py-3 flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-lg leading-tight">Collection point</div>
            <div className="text-[11px] uppercase tracking-widest text-white/55">
              {current ? `${displayName(current)} · ${current.roles.map(roleLabel).join(", ")}` : "…"}
            </div>
          </div>
          <div className="text-right text-xs text-white/70">
            <div className="font-mono text-white text-sm">{businessDate(clock) ?? "…"}</div>
            <div>Business date</div>
          </div>
        </div>

        <nav className="flex border-t border-white/15">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `flex-1 text-center px-3 py-3 text-sm font-bold uppercase tracking-wide ${
                  isActive ? "bg-fd-primary text-white" : "text-white/70 hover:text-white hover:bg-white/5"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-5 py-6">
        {error ? (
          <div className="slab p-4 border-fd-bad text-fd-bad font-semibold">Could not load the acting user: {error}</div>
        ) : loading ? (
          <div className="text-fd-inkDim text-lg">Loading…</div>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
