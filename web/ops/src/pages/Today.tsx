import { useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";

interface OpsOverview {
  businessDate: string;
  uncertainQueue: { count: number; oldestAgeMs: number };
  breakAgeing: { asOfDate: string; byCode: Record<string, { count: number; amountMinor: number; ageBuckets: Record<string, number> }> };
  settlement: { businessDate: string; scrolls: { agencyCode: string; scrollReference: string; controlTotalMinor: number; status: string; ackStatus: string }[] };
  controls: {
    trialBalance: boolean;
    allocationIntegrity: boolean;
    balanceRebuild: boolean;
    ledgerVsSubledger: boolean;
    hashChainIntact: boolean;
  };
}

const CONTROL_LABELS: [keyof OpsOverview["controls"], string][] = [
  ["trialBalance", "Trial balance ties"],
  ["allocationIntegrity", "Allocation integrity"],
  ["balanceRebuild", "Balance rebuild"],
  ["ledgerVsSubledger", "Ledger vs sub-ledger"],
  ["hashChainIntact", "Hash chain intact"],
];

export default function Today(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!date) return;
    setError(null);
    api
      .get<OpsOverview>(`/internal/ops/overview?business_date=${date}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [date]);

  if (error) return <div className="panel p-3 border-op-bad/40 bg-op-bad/[0.04] text-op-bad">{error}</div>;
  if (!data) return <div className="text-op-inkDim">Loading…</div>;

  const breaks = Object.entries(data.breakAgeing.byCode);
  const openBreakTotal = breaks.reduce((s, [, b]) => s + b.amountMinor, 0);
  const failing = CONTROL_LABELS.filter(([k]) => !data.controls[k]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Today</h1>
        <span className="text-op-inkDim text-[11px]">Everything below is cross-agency, for {date}</span>
      </div>

      {/* Top strip: what needs a human today. */}
      <div className="grid grid-cols-4 gap-2">
        <div className="metric">
          <div className="metric-label">UNCERTAIN queue</div>
          <div className="metric-value">{data.uncertainQueue.count}</div>
          <div className="text-[10px] text-op-inkDim mt-0.5">
            oldest {Math.round(data.uncertainQueue.oldestAgeMs / 60000)} min
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Open breaks</div>
          <div className="metric-value">{breaks.reduce((s, [, b]) => s + b.count, 0)}</div>
          <div className="text-[10px] text-op-inkDim mt-0.5">{pkr(openBreakTotal)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Scrolls today</div>
          <div className="metric-value">{data.settlement.scrolls.length}</div>
          <div className="text-[10px] text-op-inkDim mt-0.5">
            {data.settlement.scrolls.length === 0 ? "sweep not yet run" : "generated"}
          </div>
        </div>
        <div
          className={`metric ${failing.length > 0 ? "border-op-bad/50 bg-op-bad/[0.03]" : "border-op-good/40 bg-op-good/[0.03]"}`}
        >
          <div className="metric-label">Controls</div>
          <div className={`metric-value ${failing.length > 0 ? "text-op-bad" : "text-op-good"}`}>
            {5 - failing.length}/5
          </div>
          <div className="text-[10px] text-op-inkDim mt-0.5">
            {failing.length === 0 ? "all passing" : `${failing.length} failing`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 items-start">
        <section className="panel">
          <div className="panel-head">Break ageing — as of {data.breakAgeing.asOfDate}</div>
          {breaks.length === 0 ? (
            <div className="px-3 py-3 text-op-inkDim">
              No open breaks. Reconciliation has not been run for this date yet.
            </div>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th className="num">Count</th>
                  <th className="num">Amount</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {breaks.map(([code, b]) => (
                  <tr key={code}>
                    <td className="ref font-semibold">{code}</td>
                    <td className="num">{b.count}</td>
                    <td className="num">{pkr(b.amountMinor)}</td>
                    <td className="text-op-inkDim text-[11px]">
                      {Object.entries(b.ageBuckets)
                        .map(([bucket, n]) => `${bucket}: ${n}`)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">Control assertions</div>
          <table className="grid-table">
            <tbody>
              {CONTROL_LABELS.map(([key, label]) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td className="text-right">
                    <span className={`badge ${data.controls[key] ? "badge-good" : "badge-bad"}`}>
                      {data.controls[key] ? "pass" : "fail"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 border-t border-op-rule text-[11px] text-op-inkDim">
            Re-performed on demand against the live ledger — not cached results.
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">Scroll &amp; sweep status — {data.settlement.businessDate}</div>
        {data.settlement.scrolls.length === 0 ? (
          <div className="px-3 py-3 text-op-inkDim">
            No scroll has been generated for this business date. Provisional funds can never be swept, so a scroll is
            only ever emitted once its control total ties exactly to the ledger.
          </div>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Agency</th>
                <th>Scroll</th>
                <th className="num">Control total</th>
                <th>Status</th>
                <th>Treasury ack</th>
              </tr>
            </thead>
            <tbody>
              {data.settlement.scrolls.map((s) => (
                <tr key={s.scrollReference}>
                  <td className="font-semibold">{s.agencyCode}</td>
                  <td className="ref">{s.scrollReference}</td>
                  <td className="num">{pkr(s.controlTotalMinor)}</td>
                  <td>{s.status}</td>
                  <td>{s.ackStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
