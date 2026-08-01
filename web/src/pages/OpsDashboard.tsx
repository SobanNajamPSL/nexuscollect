import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface OpsOverview {
  businessDate: string;
  uncertainQueue: { count: number; oldestAgeMs: number };
  breakAgeing: { asOfDate: string; byCode: Record<string, { count: number; amountMinor: number; ageBuckets: Record<string, number> }> };
  settlement: { businessDate: string; scrolls: { agencyCode: string; scrollReference: string; controlTotalMinor: number; status: string; ackStatus: string }[] };
  controls: { trialBalance: boolean; allocationIntegrity: boolean; balanceRebuild: boolean; ledgerVsSubledger: boolean; hashChainIntact: boolean };
}

const DEMO_DATE = "2026-07-30";

export default function OpsDashboard() {
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<OpsOverview>(`/internal/ops/overview?business_date=${DEMO_DATE}`).then(setOverview).catch((e) => setError((e as Error).message));
  }, []);

  const controlEntries = overview
    ? ([
        ["Trial balance ties", overview.controls.trialBalance],
        ["Allocation integrity", overview.controls.allocationIntegrity],
        ["Balance rebuild", overview.controls.balanceRebuild],
        ["Ledger vs sub-ledger", overview.controls.ledgerVsSubledger],
        ["Hash-chain intact", overview.controls.hashChainIntact],
      ] as const)
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Ops Dashboard</h1>
        <p className="text-sm text-gov-ink/70 mt-1">A composed operational view — no new capability, just a single screen over the UNCERTAIN queue, break ageing, the settlement/scroll picture, and the five §10.8 control assertions.</p>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {overview && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="font-semibold text-sm mb-2">UNCERTAIN queue</div>
              <div className="flex gap-6">
                <div><div className="text-xs text-gov-ink/60">Depth</div><div className="text-2xl font-bold">{overview.uncertainQueue.count}</div></div>
                <div><div className="text-xs text-gov-ink/60">Oldest age</div><div className="text-2xl font-bold">{Math.round(overview.uncertainQueue.oldestAgeMs / 60000)} min</div></div>
              </div>
            </div>

            <div className="card p-4">
              <div className="font-semibold text-sm mb-2">Five control assertions (§10.8)</div>
              <div className="grid grid-cols-1 gap-1">
                {controlEntries.map(([name, passed]) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <span>{name}</span>
                    <span className={passed ? "text-green-700 font-semibold" : "text-red-700 font-semibold"}>{passed ? "PASS" : "FAIL"}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card p-4">
            <div className="font-semibold text-sm mb-2">Break ageing (as of {overview.breakAgeing.asOfDate})</div>
            {Object.keys(overview.breakAgeing.byCode).length === 0 ? (
              <div className="text-sm text-gov-ink/60">No open breaks.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-gov-ink/60"><tr><th>Code</th><th>Count</th><th>Amount</th><th>Age buckets</th></tr></thead>
                <tbody>
                  {Object.entries(overview.breakAgeing.byCode).map(([code, entry]) => (
                    <tr key={code} className="border-t">
                      <td className="py-1 font-mono">{code}</td>
                      <td>{entry.count}</td>
                      <td>PKR {formatPKR(entry.amountMinor)}</td>
                      <td className="text-xs text-gov-ink/70">{Object.entries(entry.ageBuckets).map(([b, c]) => `${b}: ${c}`).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card p-4">
            <div className="font-semibold text-sm mb-2">Scroll / cycle status ({overview.settlement.businessDate})</div>
            {overview.settlement.scrolls.length === 0 ? (
              <div className="text-sm text-gov-ink/60">No scrolls generated for this date.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-gov-ink/60"><tr><th>Agency</th><th>Scroll ref</th><th>Control total</th><th>Status</th><th>Ack</th></tr></thead>
                <tbody>
                  {overview.settlement.scrolls.map((s) => (
                    <tr key={s.scrollReference} className="border-t">
                      <td className="py-1">{s.agencyCode}</td>
                      <td className="font-mono text-xs">{s.scrollReference}</td>
                      <td>PKR {formatPKR(s.controlTotalMinor)}</td>
                      <td>{s.status}</td>
                      <td>{s.ackStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
