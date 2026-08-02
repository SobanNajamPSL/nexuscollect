import { useState } from "react";
import { api } from "@shared/api.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Notice, PageHead } from "../ui.js";

/**
 * The operational half of §21.1's eighteen-report pack. The five an agency reads
 * — head-wise statement, settlement, ageing, period statement, fiscal-year
 * certificate — live in the agency portal instead, because a single grid of all
 * eighteen meant neither audience had a report list that was about them.
 */
interface Def { id: string; title: string; what: string; params: (d: string) => Record<string, string> }

const REPORTS: Def[] = [
  { id: "r01", title: "R01 — Daily collection summary", what: "Everything collected on one business day, by agency, channel and rail.", params: (d) => ({ business_date: d }) },
  { id: "r03", title: "R03 — Daily reconciliation certificate", what: "A formal statement of the day's reconciliation outcome.", params: (d) => ({ business_date: d }) },
  { id: "r04", title: "R04 — Break register & ageing", what: "How long open breaks have been outstanding, by code.", params: (d) => ({ as_of_date: d }) },
  { id: "r06", title: "R06 — Unapplied receipts ageing", what: "How long money has sat unmatched to a bill.", params: (d) => ({ as_of_date: d }) },
  { id: "r08", title: "R08 — Request-to-pay funnel", what: "Sent, seen, accepted, fulfilled.", params: () => ({}) },
  { id: "r09", title: "R09 — Channel performance", what: "Volume and value by channel. Latency and cost per transaction are not tracked, and it says so.", params: () => ({}) },
  { id: "r10", title: "R10 — Fee & revenue statement", what: "Fee income and who bore it.", params: () => ({ period_start: "2026-07-01", period_end: "2026-07-31" }) },
  { id: "r11", title: "R11 — Refunds & reversals", what: "Every refund and reversal in the period.", params: () => ({ period_start: "2026-07-01", period_end: "2026-07-31" }) },
  { id: "r12", title: "R12 — Cheque performance", what: "Clearance and dishonour rates for physical instruments.", params: () => ({}) },
  { id: "r13", title: "R13 — Trial balance & control pack", what: "The five control assertions as a formal report.", params: () => ({}) },
  { id: "r15", title: "R15 — SLA & availability", what: "Partial: uptime and incident history are not tracked in this build.", params: () => ({}) },
  { id: "r16", title: "R16 — Payer experience", what: "Partial: complaint themes are not tracked in this build.", params: () => ({}) },
  { id: "r17", title: "R17 — Regulatory return", what: "Partial: no confirmed submission format, so the shape is not asserted.", params: () => ({}) },
];

export default function Reports(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const [selected, setSelected] = useState<Def | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(def: Def): Promise<void> {
    if (!date) return;
    setSelected(def); setResult(null); setError(null); setBusy(true);
    try {
      const qs = new URLSearchParams(def.params(date)).toString();
      setResult(await api.get(`/internal/reports/${def.id}${qs ? `?${qs}` : ""}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHead title="Operational reports" note="Run against live data at the moment you ask. Four of these are honestly incomplete — where the platform doesn't track an input, the report says so rather than filling the gap with a plausible number." />

      {error && <Notice tone="bad">{error}</Notice>}

      <div className="grid grid-cols-3 gap-2 mb-3">
        {REPORTS.map((r) => (
          <button key={r.id} className={`panel p-2.5 text-left hover:bg-op-panelAlt ${selected?.id === r.id ? "border-op-primary" : ""}`} onClick={() => run(r)}>
            <div className="font-semibold">{r.title}</div>
            <div className="text-[11px] text-op-inkDim mt-0.5 leading-snug">{r.what}</div>
          </button>
        ))}
      </div>

      {selected && (
        <section className="panel">
          <div className="panel-head">{selected.title}</div>
          {busy ? <div className="p-3 text-op-inkDim">Running…</div> : (
            <pre className="p-3 text-[11px] font-mono overflow-x-auto max-h-[30rem] leading-relaxed">{JSON.stringify(result, null, 2)}</pre>
          )}
        </section>
      )}
    </div>
  );
}
