import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface SearchRow { id: string; payment_reference: string; status: string; gross_amount_minor: number; channel: string; rail: string; value_date: string }
interface Payment360 {
  payment_reference: string; status: string; gross_amount_minor: number; unapplied_amount_minor: number;
  channel: string; rail: string; value_date: string; obligation_discharge_date: string; finality: string;
  application_trace: unknown;
  allocations: { psid: string; head_code: string; amount_minor: number; status: string }[];
  journal_entries: { entry_no: number; event_type: string; account_code: string; direction: string; amount_minor: number }[];
  receipt: { receipt_no: string; status: string } | null;
  recon_breaks: { break_code: string; status: string; amount_minor: number }[];
  third_party_payer: { name: string; maskedId: string; relationship: string } | null;
}

export default function PaymentSearch() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [detail, setDetail] = useState<Payment360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recallOutcome, setRecallOutcome] = useState<{ outcome: string; camt029_reason: string | null } | null>(null);
  const [recalling, setRecalling] = useState(false);

  async function search() {
    setError(null);
    try {
      setRows(await api.get<SearchRow[]>(`/internal/payments/search?q=${encodeURIComponent(q)}`));
      setDetail(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function open(ref: string) {
    setError(null);
    setRecallOutcome(null);
    try {
      setDetail(await api.get<Payment360>(`/internal/payments/${encodeURIComponent(ref)}/360`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function recall() {
    if (!detail) return;
    setRecalling(true);
    setError(null);
    try {
      const result = await api.post<{ recall_id: string; outcome: string; camt029_reason: string | null }>(
        "/internal/recalls",
        { payment_reference: detail.payment_reference, requested_reason: "SENDING_BANK_REQUEST" },
      );
      setRecallOutcome({ outcome: result.outcome, camt029_reason: result.camt029_reason });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRecalling(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Payment search &amp; 360° view</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Search by payment reference, rail end-to-end id, or switch STAN.</p>
      </div>

      <div className="flex gap-2">
        <input className="input flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. PM..." />
        <button className="btn" onClick={search}>Search</button>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {rows.length > 0 && !detail && (
        <div className="card divide-y divide-gov-border">
          {rows.map((r) => (
            <button key={r.id} className="w-full text-left p-3 hover:bg-gray-50 flex items-center justify-between" onClick={() => open(r.payment_reference)}>
              <div>
                <div className="font-medium">{r.payment_reference}</div>
                <div className="text-xs text-gov-ink/60">{r.channel} / {r.rail} — {r.value_date}</div>
              </div>
              <div className="text-right">
                <div className="font-medium">PKR {formatPKR(r.gross_amount_minor)}</div>
                <span className="badge bg-gray-100 text-gray-700 text-xs">{r.status}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {detail && (
        <div className="space-y-4">
          <button className="btn-secondary text-sm" onClick={() => setDetail(null)}>&larr; Back to results</button>
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">{detail.payment_reference}</div>
              <div className="flex items-center gap-2">
                <span className="badge bg-gray-100 text-gray-700">{detail.status}</span>
                <button className="btn-secondary text-xs" disabled={recalling} onClick={recall}>Recall payment</button>
              </div>
            </div>
            {detail.third_party_payer && (
              <div className="mt-3 text-sm bg-blue-50 text-blue-900 rounded p-2">
                Received from <strong>{detail.third_party_payer.name}</strong> ({detail.third_party_payer.maskedId}, {detail.third_party_payer.relationship}) on behalf of the assessment's payer. Any refund defaults to this account, not the taxpayer's.
              </div>
            )}
            {recallOutcome && (
              <div className="mt-3 text-sm bg-gray-50 rounded p-2">
                Recall outcome: <span className="font-medium">{recallOutcome.outcome}</span>
                {recallOutcome.camt029_reason && <span className="text-gov-ink/60"> — {recallOutcome.camt029_reason}</span>}
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
              <div><div className="text-gov-ink/60">Gross</div><div className="font-medium">PKR {formatPKR(detail.gross_amount_minor)}</div></div>
              <div><div className="text-gov-ink/60">Unapplied</div><div className="font-medium">PKR {formatPKR(detail.unapplied_amount_minor)}</div></div>
              <div><div className="text-gov-ink/60">Channel / Rail</div><div className="font-medium">{detail.channel} / {detail.rail}</div></div>
              <div><div className="text-gov-ink/60">Value date</div><div className="font-medium">{detail.value_date}</div></div>
            </div>
          </div>

          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Allocations</div>
            <table className="w-full text-sm">
              <tbody>
                {detail.allocations.map((a, i) => (
                  <tr key={i} className="border-b border-gov-border last:border-0">
                    <td className="p-3">{a.psid}</td><td className="p-3">{a.head_code}</td>
                    <td className="p-3 text-right">PKR {formatPKR(a.amount_minor)}</td>
                    <td className="p-3"><span className="badge bg-gray-100 text-gray-700 text-xs">{a.status}</span></td>
                  </tr>
                ))}
                {detail.allocations.length === 0 && <tr><td className="p-3 text-gov-ink/60" colSpan={4}>No allocations.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="p-3 font-semibold bg-gray-50">Journal entries</div>
            <table className="w-full text-sm">
              <tbody>
                {detail.journal_entries.map((j, i) => (
                  <tr key={i} className="border-b border-gov-border last:border-0">
                    <td className="p-3">#{j.entry_no}</td><td className="p-3">{j.event_type}</td><td className="p-3">{j.account_code}</td>
                    <td className="p-3">{j.direction}</td><td className="p-3 text-right">PKR {formatPKR(j.amount_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="font-semibold mb-2">Receipt</div>
              {detail.receipt ? <div>{detail.receipt.receipt_no} — <span className="badge bg-gray-100 text-gray-700 text-xs">{detail.receipt.status}</span></div> : <div className="text-gov-ink/60 text-sm">No receipt.</div>}
            </div>
            <div className="card p-4">
              <div className="font-semibold mb-2">Recon status</div>
              {detail.recon_breaks.length === 0 ? <div className="text-sm text-green-700">No breaks against this payment.</div> : detail.recon_breaks.map((b, i) => (
                <div key={i} className="text-sm">{b.break_code} — PKR {formatPKR(b.amount_minor)} ({b.status})</div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <div className="font-semibold mb-2">Application trace</div>
            <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto">{JSON.stringify(detail.application_trace, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
