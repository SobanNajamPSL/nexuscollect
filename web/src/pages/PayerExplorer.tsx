import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface PayerHit { id: string; name: string; payer_type: string; msisdn_e164: string | null }
interface Payer360 {
  payer_id: string; name: string; payer_type: string; risk_rating: string;
  accounts: { agency_code: string; crn: string; status: string }[];
  assessments: { psid: string; status: string; balance_minor: number }[];
  payments: { payment_reference: string; status: string; gross_amount_minor: number }[];
  refunds: { refund_reference: string; status: string; amount_minor: number }[];
  mandates: { id: string; mandate_reference: string; status: string; max_amount_minor: number }[];
}

export default function PayerExplorer() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PayerHit[]>([]);
  const [data, setData] = useState<Payer360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMandateForm, setShowMandateForm] = useState(false);
  const [productCode, setProductCode] = useState("");
  const [maxAmountPkr, setMaxAmountPkr] = useState("");
  const [frequency, setFrequency] = useState<"MONTHLY" | "QUARTERLY" | "ANNUAL">("ANNUAL");
  const [collectingRef, setCollectingRef] = useState<string | null>(null);
  const [collectPsid, setCollectPsid] = useState("");
  const [collectAmountPkr, setCollectAmountPkr] = useState("");
  const [collectResult, setCollectResult] = useState<string | null>(null);

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

  async function createMandate(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setError(null);
    try {
      await api.post("/internal/mandates", {
        payer_reference: data.payer_id,
        product_code: productCode,
        max_amount_minor: Math.round(Number(maxAmountPkr) * 100),
        frequency,
        first_collection_date: "2026-08-30",
      });
      setShowMandateForm(false);
      setProductCode(""); setMaxAmountPkr("");
      await open(data.payer_id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function collectNow(mandateReference: string, mandateId: string) {
    setError(null);
    setCollectResult(null);
    try {
      const res = await api.post<{ outcome: string; payment_id: string | null; retry_count: number }>(`/internal/mandates/${mandateId}/collect`, {
        psid: collectPsid,
        amount_minor: Math.round(Number(collectAmountPkr) * 100),
        value_date: "2026-07-30",
      });
      setCollectResult(`${mandateReference}: ${res.outcome}${res.payment_id ? ` — payment ${res.payment_id}` : ""}`);
      setCollectingRef(null);
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
              <div className="p-3 font-semibold bg-gray-50 flex items-center justify-between">
                <span>Mandates</span>
                <button className="btn-secondary text-xs" onClick={() => setShowMandateForm((s) => !s)}>{showMandateForm ? "Cancel" : "Create mandate"}</button>
              </div>
              {showMandateForm && (
                <form onSubmit={createMandate} className="p-3 space-y-2 border-b border-gov-border">
                  <input className="input w-full text-sm" value={productCode} onChange={(e) => setProductCode(e.target.value)} placeholder="Product code (e.g. ETPB-TOKEN-TAX)" required />
                  <div className="grid grid-cols-2 gap-2">
                    <input className="input text-sm" type="number" step="0.01" value={maxAmountPkr} onChange={(e) => setMaxAmountPkr(e.target.value)} placeholder="Max amount (PKR)" required />
                    <select className="input text-sm" value={frequency} onChange={(e) => setFrequency(e.target.value as never)}>
                      <option value="MONTHLY">Monthly</option>
                      <option value="QUARTERLY">Quarterly</option>
                      <option value="ANNUAL">Annual</option>
                    </select>
                  </div>
                  <button className="btn text-sm" type="submit">Create — pre-notification required before every debit</button>
                </form>
              )}
              {data.mandates.map((m) => (
                <div key={m.id} className="p-3 text-sm border-b border-gov-border last:border-0">
                  <div className="flex items-center justify-between">
                    <span>{m.mandate_reference} — PKR {formatPKR(m.max_amount_minor)} max ({m.status})</span>
                    <button className="btn-secondary text-xs" onClick={() => setCollectingRef(collectingRef === m.id ? null : m.id)}>Collect now</button>
                  </div>
                  {collectingRef === m.id && (
                    <div className="mt-2 flex gap-2">
                      <input className="input text-xs flex-1" value={collectPsid} onChange={(e) => setCollectPsid(e.target.value)} placeholder="PSID to collect against" />
                      <input className="input text-xs w-28" type="number" step="0.01" value={collectAmountPkr} onChange={(e) => setCollectAmountPkr(e.target.value)} placeholder="PKR" />
                      <button className="btn text-xs" onClick={() => collectNow(m.mandate_reference, m.id)}>Go</button>
                    </div>
                  )}
                </div>
              ))}
              {data.mandates.length === 0 && <div className="p-3 text-sm text-gov-ink/60">No mandates.</div>}
              {collectResult && <div className="p-3 text-xs bg-gray-50">{collectResult}</div>}
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
