import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface PayerHit { id: string; name: string; payer_type: string; msisdn_e164: string | null }
interface Payer360 {
  payer_id: string; name: string; payer_type: string; risk_rating: string;
  accounts: { agency_code: string; crn: string; status: string }[];
  assessments: { psid: string; status: string; balance_minor: number }[];
  payments: { payment_reference: string; status: string; gross_amount_minor: number }[];
  refunds: { refund_reference: string; status: string; amount_minor: number }[];
  mandates: { mandate_reference: string; status: string; max_amount_minor: number }[];
}

export default function PayerExplorer() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PayerHit[]>([]);
  const [data, setData] = useState<Payer360 | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setError(null);
    setData(null);
    try {
      setHits(await api.get<PayerHit[]>(`/internal/payers/search?q=${encodeURIComponent(q)}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function open(id: string) {
    setError(null);
    try {
      setData(await api.get<Payer360>(`/internal/payers/${id}/360`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Payer 360° view</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Accounts, assessments, payments, refunds, and mandates for one payer.</p>
      </div>

      <div className="flex gap-2">
        <input className="input flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Payer name" />
        <button className="btn" onClick={search}>Search</button>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {hits.length > 0 && !data && (
        <div className="card divide-y divide-gov-border">
          {hits.map((h) => (
            <button key={h.id} className="w-full text-left p-3 hover:bg-gray-50" onClick={() => open(h.id)}>
              <div className="font-medium">{h.name}</div>
              <div className="text-xs text-gov-ink/60">{h.payer_type} {h.msisdn_e164 ? `— ${h.msisdn_e164}` : ""}</div>
            </button>
          ))}
        </div>
      )}

      {data && (
        <div className="space-y-4">
          <button className="btn-secondary text-sm" onClick={() => setData(null)}>&larr; Back</button>
          <div className="card p-4 flex items-center justify-between">
            <div><div className="font-semibold text-lg">{data.name}</div><div className="text-xs text-gov-ink/60">{data.payer_type}</div></div>
            <span className="badge bg-gray-100 text-gray-700">Risk: {data.risk_rating}</span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card">
              <div className="p-3 font-semibold bg-gray-50">Accounts</div>
              {data.accounts.map((a, i) => <div key={i} className="p-3 text-sm border-b border-gov-border last:border-0">{a.agency_code} — {a.crn} ({a.status})</div>)}
            </div>
            <div className="card">
              <div className="p-3 font-semibold bg-gray-50">Mandates</div>
              {data.mandates.map((m, i) => <div key={i} className="p-3 text-sm border-b border-gov-border last:border-0">{m.mandate_reference} — PKR {formatPKR(m.max_amount_minor)} max ({m.status})</div>)}
              {data.mandates.length === 0 && <div className="p-3 text-sm text-gov-ink/60">No mandates.</div>}
            </div>
          </div>

          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Assessments</div>
            {data.assessments.map((a, i) => <div key={i} className="p-3 text-sm border-b border-gov-border last:border-0 flex justify-between"><span>{a.psid}</span><span>{a.status} — PKR {formatPKR(a.balance_minor)} owing</span></div>)}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card">
              <div className="p-3 font-semibold bg-gray-50">Payments</div>
              {data.payments.map((p, i) => <div key={i} className="p-3 text-sm border-b border-gov-border last:border-0">{p.payment_reference} — PKR {formatPKR(p.gross_amount_minor)} ({p.status})</div>)}
            </div>
            <div className="card">
              <div className="p-3 font-semibold bg-gray-50">Refunds</div>
              {data.refunds.map((r, i) => <div key={i} className="p-3 text-sm border-b border-gov-border last:border-0">{r.refund_reference} — PKR {formatPKR(r.amount_minor)} ({r.status})</div>)}
              {data.refunds.length === 0 && <div className="p-3 text-sm text-gov-ink/60">No refunds.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
