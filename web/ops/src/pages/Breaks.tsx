import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Empty, Notice, PageHead, Severity, Status } from "../ui.js";

interface Break {
  id: string;
  break_code: string;
  severity: string;
  amount_minor: number;
  business_date: string;
  status: string;
  resolution_type: string | null;
  narrative_raw: string | null;
  agency_code: string | null;
  payment_reference: string | null;
  maker_user_name: string | null;
  proposed_resolution: string | null;
  proposed_narrative: string | null;
}

const RESOLUTIONS: { value: string; label: string; when: string }[] = [
  { value: "MANUAL_MATCH", label: "Manual match", when: "the two sides are the same money, matched by hand" },
  { value: "ACCEPT_TIMING", label: "Accept timing", when: "same money, different booking day" },
  { value: "RECLASSIFY", label: "Reclassify", when: "banked correctly but posted to the wrong head" },
  { value: "WRITE_OFF", label: "Write off", when: "a residual small enough to absorb" },
  { value: "ESCALATE_TO_AGENCY", label: "Escalate to agency", when: "only the agency can decide" },
];

/**
 * The break register, now reading persisted breaks rather than whatever the last
 * reconciliation run happened to return — which is what lets it show a break's
 * *state* and not merely its existence.
 *
 * Propose and approve are separately role-gated (§3.2): an analyst may propose
 * but not approve, an approver may approve but not propose. The buttons follow
 * the acting persona's actual roles rather than being shown to everyone and
 * failing on click.
 */
export default function Breaks(): JSX.Element {
  const { current } = usePersona();
  const clock = useDemoClock();
  const date = businessDate(clock);
  const roles = current?.roles ?? [];
  const canPropose = roles.includes("OPS_RECON_ANALYST");
  const canApprove = roles.includes("OPS_RECON_APPROVER");

  const [rows, setRows] = useState<Break[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [proposing, setProposing] = useState<string | null>(null);
  const [resolution, setResolution] = useState(RESOLUTIONS[0]!.value);
  const [narrative, setNarrative] = useState("");

  const load = useCallback(async () => {
    if (!date) return;
    setError(null);
    try {
      setRows(await api.get<Break[]>(`/internal/breaks?business_date=${date}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runRecon(): Promise<void> {
    setBusy("recon");
    setError(null);
    setDone(null);
    try {
      const res = await api.post<{ break_count: number }>("/internal/recon/run", { business_date: date }, { idempotent: false });
      setDone(`Reconciliation complete — ${res.break_count} breaks. Re-running is idempotent: the same sources produce the same breaks.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function propose(b: Break): Promise<void> {
    setBusy(b.id);
    setError(null);
    setDone(null);
    try {
      await api.post(`/internal/breaks/${b.id}/propose`, { resolution_type: resolution, narrative });
      setDone(`${b.break_code}: ${resolution} proposed. It stays open until a reconciliation approver signs it off.`);
      setProposing(null);
      setNarrative("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function decide(b: Break, verdict: "approve" | "reject"): Promise<void> {
    setBusy(b.id);
    setError(null);
    setDone(null);
    try {
      await api.post(`/internal/breaks/${b.id}/${verdict}`, verdict === "reject" ? { comment: "Returned to the analyst." } : {});
      setDone(verdict === "approve" ? `${b.break_code} resolved.` : `${b.break_code} sent back to the analyst.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const open = rows.filter((r) => r.status === "OPEN");
  const pending = rows.filter((r) => r.status === "PENDING_APPROVAL");
  const resolved = rows.filter((r) => r.status === "RESOLVED");
  const unexplained = open.reduce((s, r) => s + Math.abs(r.amount_minor), 0);

  return (
    <div>
      <PageHead
        title={`Break register — ${date ?? "…"}`}
        right={
          <button className="btn" disabled={busy !== null} onClick={runRecon}>
            {busy === "recon" ? "Running…" : "Run reconciliation"}
          </button>
        }
        note="Three-way reconciliation against the bank statement, the switch settlement file and the rail settlement file. A break is a disagreement between two systems' records — not necessarily missing money, which is why the resolution says what actually happened."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      {rows.length === 0 ? (
        <div className="panel">
          <Empty>Reconciliation has not been run for this business date.</Empty>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 mb-4">
            <div className="metric">
              <div className="metric-label">Breaks found</div>
              <div className="metric-value">{rows.length}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Auto-resolved</div>
              <div className="metric-value text-op-good">{resolved.length}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Awaiting approval</div>
              <div className="metric-value text-op-warn">{pending.length}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Open — unexplained</div>
              <div className="metric-value text-op-bad">{pkr(unexplained)}</div>
            </div>
          </div>

          {!canPropose && !canApprove && (
            <Notice tone="warn">
              Acting as a role that can neither propose nor approve a resolution. The analyst and approver roles are
              segregated, so switch persona to act on a break.
            </Notice>
          )}

          <BreakTable
            title="Awaiting approval"
            rows={pending}
            empty="Nothing awaiting approval."
            render={(b) => (
              <>
                <div className="text-[11px] text-op-inkDim">
                  {b.proposed_resolution} proposed{b.maker_user_name ? ` by ${b.maker_user_name.replace(/\s*\(.*\)$/, "")}` : ""}
                  {b.proposed_narrative ? ` — “${b.proposed_narrative}”` : ""}
                </div>
                {canApprove ? (
                  <div className="flex gap-1 mt-1">
                    <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => decide(b, "approve")}>
                      Approve
                    </button>
                    <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => decide(b, "reject")}>
                      Send back
                    </button>
                  </div>
                ) : (
                  <div className="text-[11px] text-op-inkDim italic mt-1">Requires a reconciliation approver.</div>
                )}
              </>
            )}
          />

          <BreakTable
            title="Open"
            rows={open}
            empty="No open breaks."
            render={(b) =>
              proposing === b.id ? (
                <div className="mt-1 space-y-1.5">
                  <select className="select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                    {RESOLUTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label} — {r.when}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    placeholder="What you found, and why this resolution"
                    value={narrative}
                    onChange={(e) => setNarrative(e.target.value)}
                  />
                  <div className="flex gap-1">
                    <button className="btn btn-xs" disabled={busy !== null || narrative.trim() === ""} onClick={() => propose(b)}>
                      Propose
                    </button>
                    <button className="btn-secondary btn-xs" onClick={() => setProposing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : canPropose ? (
                <button className="btn-secondary btn-xs mt-1" onClick={() => setProposing(b.id)}>
                  Propose a resolution
                </button>
              ) : null
            }
          />

          <BreakTable title="Resolved" rows={resolved} empty="Nothing resolved yet." muted render={(b) => (
            <div className="text-[11px] text-op-inkDim">
              {b.resolution_type ? b.resolution_type.replace(/_/g, " ").toLowerCase() : "auto-resolved by the run"}
            </div>
          )} />
        </>
      )}
    </div>
  );
}

function BreakTable({
  title,
  rows,
  empty,
  render,
  muted,
}: {
  title: string;
  rows: Break[];
  empty: string;
  render: (b: Break) => JSX.Element | null;
  muted?: boolean;
}): JSX.Element {
  return (
    <section className={`panel mb-4 ${muted ? "opacity-75" : ""}`}>
      <div className="panel-head">
        {title} — {rows.length}
      </div>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th style={{ width: "4rem" }}>Code</th>
              <th>Detail</th>
              <th style={{ width: "6rem" }}>Severity</th>
              <th style={{ width: "5rem" }}>Agency</th>
              <th className="num" style={{ width: "9rem" }}>
                Amount
              </th>
              <th style={{ width: "7rem" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td className="ref font-bold">{b.break_code}</td>
                <td>
                  {b.payment_reference && <span className="ref">{b.payment_reference}</span>}
                  {b.narrative_raw && (
                    <div className="text-[11px] text-op-inkDim italic">“{b.narrative_raw}”</div>
                  )}
                  {render(b)}
                </td>
                <td>
                  <Severity value={b.severity} />
                </td>
                <td>{b.agency_code ?? <span className="text-op-inkDim">—</span>}</td>
                <td className="num">{pkr(Math.abs(b.amount_minor))}</td>
                <td>
                  <Status value={b.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
