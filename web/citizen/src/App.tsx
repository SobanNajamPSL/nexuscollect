import { NavLink, Outlet } from "react-router-dom";
import { HarnessBar } from "@shared/HarnessBar.js";

/**
 * Citizen portal shell.
 *
 * Public and unauthenticated — there is no persona switcher here, because there
 * is nobody to be. A bill is found by reference and a check digit, never by
 * logging in, which is what lets this work for someone who has never used the
 * platform before and never will again.
 *
 * The whole portal sits inside a phone-width frame even on a desktop, so a
 * reviewer sees it for what it is rather than as a stretched-out mobile page.
 */
export default function App(): JSX.Element {
  return (
    <div className="min-h-screen flex flex-col bg-neutral-200">
      <HarnessBar portal="citizen" />

      <div className="flex-1 flex justify-center py-0 sm:py-6">
        <div className="phone w-full sm:rounded-2xl sm:shadow-xl sm:overflow-hidden bg-cz-bg flex flex-col">
          {/* Deliberately not any one government's name: a single reference here
              legitimately returns bills from a federal board and a provincial
              authority at once, and claiming either would be inaccurate. */}
          <header className="bg-cz-primary text-white px-5 pt-5 pb-4">
            <div className="text-[11px] uppercase tracking-widest text-white/60">NexusCollect</div>
            <div className="text-lg font-semibold mt-0.5">Pay a government bill</div>
          </header>

          <nav className="flex border-b border-cz-rule bg-white text-sm">
            <Tab to="/" label="Pay a bill" />
            <Tab to="/verify" label="Check a receipt" />
          </nav>

          <main className="flex-1 px-5 py-5">
            <Outlet />
          </main>

          <footer className="px-5 py-4 text-[11px] text-cz-inkDim border-t border-cz-rule">
            No account needed. Your bill is found by its reference number.
          </footer>
        </div>
      </div>
    </div>
  );
}

function Tab({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `flex-1 text-center py-3 font-medium border-b-2 -mb-px transition-colors ${
          isActive ? "border-cz-primary text-cz-primary" : "border-transparent text-cz-inkDim hover:text-cz-ink"
        }`
      }
    >
      {label}
    </NavLink>
  );
}
