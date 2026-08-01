import { useState } from "react";
import { api } from "./api.js";
import { usePersona } from "./PersonaContext.js";
import { displayName, roleLabel, type PortalId } from "./personas.js";
import { businessDateTime, readDemoClock, useDemoClock } from "./demoClock.js";

/**
 * The demonstration harness.
 *
 * Three of this build's controls exist only to make a demonstration possible
 * and belong to no real user: resetting the database, moving the demo clock,
 * and deliberately corrupting a ledger row. Putting any of them inside a portal
 * would be dishonest — no operations user has a "break the ledger" button.
 *
 * So they live here instead, in chrome that announces itself as scaffolding.
 * On camera this *strengthens* the tamper demonstration rather than weakening
 * it: you are visibly reaching in from outside the system to corrupt a row, and
 * then watching the system catch you.
 *
 * The persona switcher and the portal switcher are the same kind of thing —
 * harness concerns, not product — so they belong here too.
 */

const PORTALS: { id: PortalId; label: string; origin: string }[] = [
  { id: "citizen", label: "Citizen", origin: "http://pay.localhost:5174" },
  { id: "agency", label: "Agency", origin: "http://agency.localhost:5175" },
  { id: "ops", label: "Operator", origin: "http://ops.localhost:5176" },
  { id: "field", label: "Field", origin: "http://field.localhost:5177" },
];

export function HarnessBar({ portal }: { portal: PortalId }): JSX.Element {
  const { personas, current, setCurrent } = usePersona();
  const now = useDemoClock();
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<string>): Promise<void> {
    setBusy(label);
    setFlash(null);
    try {
      setFlash(await fn());
      await readDemoClock();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setTimeout(() => setFlash(null), 6000);
    }
  }

  const advanceDay = (): Promise<void> =>
    run("clock", async () => {
      const res = await api.post<{ now: string }>(
        "/internal/demo/advance-clock",
        { by_ms: 24 * 60 * 60 * 1000 },
        { idempotent: false },
      );
      return `Clock advanced to ${businessDateTime(res.now)} — surcharge now accrues one more day.`;
    });

  const reset = (): Promise<void> =>
    run("reset", async () => {
      const res = await api.post<{ took_ms: number }>("/internal/demo/reset", {}, { idempotent: false });
      // Anything the portal was showing is now stale by construction.
      setTimeout(() => window.location.reload(), 400);
      return `Restored to the opening state in ${res.took_ms} ms.`;
    });

  const tamper = (): Promise<void> =>
    run("tamper", async () => {
      const res = await api.post<{ tampered_entry_no?: number }>("/internal/demo/tamper-chain", {}, { idempotent: false });
      return `Ledger entry ${res.tampered_entry_no ?? "?"} corrupted from outside the application. Run the hash-chain check.`;
    });

  return (
    <div className="bg-harness-bg text-harness-ink font-sans text-xs border-b border-harness-border">
      <div className="flex items-center gap-4 px-4 py-1.5 flex-wrap">
        <span className="font-semibold tracking-widest text-harness-warn uppercase text-[10px] whitespace-nowrap">
          Demonstration harness
        </span>

        <span className="h-4 w-px bg-harness-border" aria-hidden />

        {/* Portal switcher — how you move between four separately-served apps
            without typing hostnames on camera. */}
        <nav className="flex items-center gap-1" aria-label="Switch portal">
          {PORTALS.map((p) => (
            <a
              key={p.id}
              href={p.origin}
              className={`px-2 py-0.5 rounded ${
                p.id === portal
                  ? "bg-harness-bgAlt text-white font-semibold"
                  : "text-harness-inkDim hover:text-harness-ink"
              }`}
            >
              {p.label}
            </a>
          ))}
        </nav>

        <span className="h-4 w-px bg-harness-border" aria-hidden />

        {/* Identity. Absent for the citizen portal, which is genuinely public. */}
        {personas.length > 0 ? (
          <label className="flex items-center gap-2">
            <span className="text-harness-inkDim">Acting as</span>
            <select
              className="bg-harness-bgAlt border border-harness-border rounded px-2 py-0.5 text-harness-ink"
              value={current?.id ?? ""}
              onChange={(e) => {
                const next = personas.find((p) => p.id === e.target.value);
                if (next) {
                  setCurrent(next);
                  window.location.reload();
                }
              }}
            >
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {displayName(p)} — {p.roles.map(roleLabel).join(", ")}
                  {p.agency_code ? ` · ${p.agency_code}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-harness-inkDim italic">No sign-in — this portal is public</span>
        )}

        <div className="flex items-center gap-3 ml-auto">
          <span className="text-harness-inkDim whitespace-nowrap">
            Demo clock <span className="font-mono text-harness-ink">{businessDateTime(now) ?? "…"}</span> PKT
          </span>
          <button className="harness-btn" disabled={busy !== null} onClick={advanceDay}>
            +1 day
          </button>
          <button className="harness-btn" disabled={busy !== null} onClick={reset}>
            {busy === "reset" ? "Resetting…" : "Reset"}
          </button>
          <button className="harness-btn harness-btn-danger" disabled={busy !== null} onClick={tamper}>
            Break the chain
          </button>
        </div>
      </div>

      {flash && (
        <div className="px-4 pb-1.5 -mt-0.5 text-harness-warn font-mono text-[11px]">{flash}</div>
      )}
    </div>
  );
}
