import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface Overview {
  businessDate: string;
  scrolls: { agencyCode: string; scrollReference: string; controlTotalMinor: number; status: string; ackStatus: string | null }[];
  sweeps: { agencyCode: string; paymentReference: string; amountMinor: number }[];
}

const AGENCIES = ["FBR", "PSCA", "ETPB", "LHC", "BOR", "WASA", "NADRA"];

export default function SettlementSweep() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [agencyCode, setAgencyCode] = useState("FBR");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setOverview(await api.get<Overview>("/internal/settlement/overview?business_date=2026-07-30"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sweep() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/internal/settlement/${agencyCode}/sweep`, { business_date: "2026-07-30" }, { idempotent: false });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gov-primaryDark">Settlement &amp; sweep</h1>
          <p className="text-sm text-gov-ink/70 mt-1">Cycle status, sweep authorisation, scroll and ack status.</p>
        </div>
        <div className="flex gap-2">
          <select className="input w-32" value={agencyCode} onChange={(e) => setAgencyCode(e.target.value)}>
            {AGENCIES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <button disabled={busy} className="btn" onClick={sweep}>Sweep</button>
          <button className="btn-secondary" onClick={refresh}>Refresh</button>
        </div>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {overview && (
        <div className="grid grid-cols-2 gap-4">
          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Scrolls — {overview.businessDate}</div>
            {overview.scrolls.map((s, i) => (
              <div key={i} className="p-3 text-sm border-b border-gov-border last:border-0 flex justify-between">
                <span>{s.agencyCode} — {s.scrollReference}</span>
                <span>PKR {formatPKR(s.controlTotalMinor)} — {s.status}{s.ackStatus ? ` (${s.ackStatus})` : ""}</span>
              </div>
            ))}
            {overview.scrolls.length === 0 && <div className="p-3 text-sm text-gov-ink/60">No scrolls yet.</div>}
          </div>
          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Sweeps (outbound)</div>
            {overview.sweeps.map((s, i) => (
              <div key={i} className="p-3 text-sm border-b border-gov-border last:border-0 flex justify-between">
                <span>{s.agencyCode} — {s.paymentReference}</span><span>PKR {formatPKR(s.amountMinor)}</span>
              </div>
            ))}
            {overview.sweeps.length === 0 && <div className="p-3 text-sm text-gov-ink/60">No sweeps yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
