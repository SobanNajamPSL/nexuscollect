import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface HeadWise {
  head_code: string;
  head_name: string;
  allocated_minor: number;
}
interface StatusCount {
  status: string;
  count: number;
  balance_total_minor: number;
}
interface DashboardDto {
  agency_code: string;
  agency_name: string;
  head_wise: HeadWise[];
  total_confirmed_minor: number;
  total_settled_minor: number;
  total_swept_minor: number | null;
  assessment_status_counts: StatusCount[];
}

const AGENCIES = ["FBR", "PSCA", "ETPB", "LHC", "BOR", "WASA", "NADRA"];

export default function AgencyDashboard() {
  const [agencyCode, setAgencyCode] = useState("FBR");
  const [data, setData] = useState<DashboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setData(null);
    api
      .get<DashboardDto>(`/internal/agency/${agencyCode}/dashboard`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [agencyCode]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gov-primaryDark">Agency dashboard</h1>
          <p className="text-sm text-gov-ink/70 mt-1">Head-wise position — confirmed, settled and swept are three separate figures, never merged.</p>
        </div>
        <select className="input w-40" value={agencyCode} onChange={(e) => setAgencyCode(e.target.value)}>
          {AGENCIES.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-4 text-center">
              <div className="text-2xl font-bold">PKR {formatPKR(data.total_confirmed_minor)}</div>
              <div className="text-xs text-gov-ink/60">Confirmed (applied allocations)</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-2xl font-bold">PKR {formatPKR(data.total_settled_minor)}</div>
              <div className="text-xs text-gov-ink/60">Settled</div>
            </div>
            <div className="card p-4 text-center opacity-60">
              <div className="text-2xl font-bold">{data.total_swept_minor === null ? "—" : `PKR ${formatPKR(data.total_swept_minor)}`}</div>
              <div className="text-xs text-gov-ink/60">Swept (Phase 5 — not yet implemented)</div>
            </div>
          </div>

          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Head-wise allocated position</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gov-ink/60 border-b border-gov-border">
                  <th className="p-3">Revenue head</th>
                  <th className="p-3 text-right">Allocated</th>
                </tr>
              </thead>
              <tbody>
                {data.head_wise.map((h) => (
                  <tr key={h.head_code} className="border-b border-gov-border last:border-0">
                    <td className="p-3">{h.head_code} — {h.head_name}</td>
                    <td className="p-3 text-right font-medium">PKR {formatPKR(h.allocated_minor)}</td>
                  </tr>
                ))}
                {data.head_wise.length === 0 && (
                  <tr><td className="p-3 text-gov-ink/60" colSpan={2}>No allocations recorded for this agency yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Assessment status breakdown</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gov-ink/60 border-b border-gov-border">
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Count</th>
                  <th className="p-3 text-right">Outstanding balance</th>
                </tr>
              </thead>
              <tbody>
                {data.assessment_status_counts.map((s) => (
                  <tr key={s.status} className="border-b border-gov-border last:border-0">
                    <td className="p-3">{s.status}</td>
                    <td className="p-3 text-right">{s.count}</td>
                    <td className="p-3 text-right">PKR {formatPKR(s.balance_total_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
