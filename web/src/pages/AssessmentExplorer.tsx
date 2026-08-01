import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface Assessment360 {
  psid: string; current_version: number; status: string;
  versions: { version: number; status: string; assessed_amount_minor: number; payable_amount_minor: number; allocated_amount_minor: number; balance_minor: number }[];
  line_items: { head_code: string; line_type: string; amount_minor: number; allocated_minor: number }[];
  payment_history: { payment_reference: string; amount_minor: number; status: string; applied_at: string }[];
  notifications: { event_type: string; channel: string; status: string; sent_at: string }[];
}

export default function AssessmentExplorer() {
  const [psid, setPsid] = useState("");
  const [data, setData] = useState<Assessment360 | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    setData(null);
    try {
      setData(await api.get<Assessment360>(`/internal/assessments/${encodeURIComponent(psid)}/360`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Assessment 360° view</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Versions, line items, payment history and notifications for one PSID.</p>
      </div>

      <div className="flex gap-2">
        <input className="input flex-1" value={psid} onChange={(e) => setPsid(e.target.value)} placeholder="PSID" />
        <button className="btn" onClick={load}>Look up</button>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {data && (
        <div className="space-y-4">
          <div className="card p-4 flex items-center justify-between">
            <div className="font-semibold text-lg">{data.psid}</div>
            <span className="badge bg-gray-100 text-gray-700">{data.status} (v{data.current_version})</span>
          </div>

          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Version history</div>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gov-ink/60 border-b border-gov-border"><th className="p-3">v</th><th className="p-3">Status</th><th className="p-3 text-right">Assessed</th><th className="p-3 text-right">Payable</th><th className="p-3 text-right">Allocated</th><th className="p-3 text-right">Balance</th></tr></thead>
              <tbody>
                {data.versions.map((v) => (
                  <tr key={v.version} className="border-b border-gov-border last:border-0">
                    <td className="p-3">{v.version}</td><td className="p-3">{v.status}</td>
                    <td className="p-3 text-right">PKR {formatPKR(v.assessed_amount_minor)}</td>
                    <td className="p-3 text-right">PKR {formatPKR(v.payable_amount_minor)}</td>
                    <td className="p-3 text-right">PKR {formatPKR(v.allocated_amount_minor)}</td>
                    <td className="p-3 text-right">PKR {formatPKR(v.balance_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Line items (current version)</div>
            <table className="w-full text-sm">
              <tbody>
                {data.line_items.map((l, i) => (
                  <tr key={i} className="border-b border-gov-border last:border-0">
                    <td className="p-3">{l.head_code}</td><td className="p-3">{l.line_type}</td>
                    <td className="p-3 text-right">PKR {formatPKR(l.amount_minor)}</td>
                    <td className="p-3 text-right">PKR {formatPKR(l.allocated_minor)} allocated</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card">
              <div className="p-3 font-semibold bg-gray-50">Payment history</div>
              <div className="divide-y divide-gov-border">
                {data.payment_history.map((p, i) => (
                  <div key={i} className="p-3 text-sm flex justify-between"><span>{p.payment_reference}</span><span>PKR {formatPKR(p.amount_minor)} ({p.status})</span></div>
                ))}
                {data.payment_history.length === 0 && <div className="p-3 text-sm text-gov-ink/60">No payments yet.</div>}
              </div>
            </div>
            <div className="card">
              <div className="p-3 font-semibold bg-gray-50">Notifications sent</div>
              <div className="divide-y divide-gov-border">
                {data.notifications.map((n, i) => (
                  <div key={i} className="p-3 text-sm flex justify-between"><span>{n.event_type} ({n.channel})</span><span className="badge bg-gray-100 text-gray-700 text-xs">{n.status}</span></div>
                ))}
                {data.notifications.length === 0 && <div className="p-3 text-sm text-gov-ink/60">None sent.</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
