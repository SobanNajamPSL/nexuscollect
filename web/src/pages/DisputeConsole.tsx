import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface DisputeRow {
  id: string;
  payment_reference: string;
  scheme_reason_code: string;
  amount_minor: number;
  status: string;
  liability: string | null;
  created_at: string;
}

const REASON_CODES = ["10.4 - Other Fraud", "13.1 - Merchandise/Service Not Received", "12.6.1 - Duplicate Processing", "13.6 - Credit Not Processed"];

export default function DisputeConsole() {
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paymentReference, setPaymentReference] = useState("");
  const [reasonCode, setReasonCode] = useState(REASON_CODES[0]!);
  const [amountPkr, setAmountPkr] = useState("");
  const [evidenceByDispute, setEvidenceByDispute] = useState<Record<string, unknown>>({});
  const [liability, setLiability] = useState<Record<string, "OPERATOR" | "AGENCY" | "SHARED">>({});

  async function refresh() {
    try {
      setRows(await api.get<DisputeRow[]>("/internal/disputes"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/internal/disputes", { payment_reference: paymentReference, scheme_reason_code: reasonCode, amount_minor: Math.round(Number(amountPkr) * 100) });
      setPaymentReference(""); setAmountPkr("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function assembleEvidence(id: string) {
    setError(null);
    try {
      const res = await api.post<{ evidence_bundle: unknown }>(`/internal/disputes/${id}/evidence`, {});
      setEvidenceByDispute((prev) => ({ ...prev, [id]: res.evidence_bundle }));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resolve(id: string, outcome: "WON" | "LOST") {
    setError(null);
    try {
      await api.post(`/internal/disputes/${id}/resolve`, { outcome, liability: liability[id] ?? "AGENCY" });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Dispute / Chargeback Console</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Cards are the one rail where a citizen can reverse a completed payment weeks later. The strongest evidence is proof the government service was actually delivered.</p>
      </div>

      <form onSubmit={create} className="card p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
        <input className="input" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="Card payment reference" required />
        <select className="input" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
          {REASON_CODES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input className="input" type="number" step="0.01" value={amountPkr} onChange={(e) => setAmountPkr(e.target.value)} placeholder="Amount (PKR)" required />
        <button className="btn" type="submit">Raise dispute</button>
      </form>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      <div className="card divide-y divide-gov-border">
        {rows.map((d) => (
          <div key={d.id} className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{d.payment_reference} — {d.scheme_reason_code}</div>
                <div className="text-xs text-gov-ink/60">Raised {new Date(d.created_at).toLocaleDateString()}{d.liability ? ` · liability: ${d.liability}` : ""}</div>
              </div>
              <div className="text-right">
                <div className="font-medium">PKR {formatPKR(d.amount_minor)}</div>
                <span className="badge bg-gray-100 text-gray-700 text-xs">{d.status}</span>
              </div>
            </div>
            {d.status === "RECEIVED" && (
              <button className="btn-secondary text-xs" onClick={() => assembleEvidence(d.id)}>Assemble evidence bundle</button>
            )}
            {evidenceByDispute[d.id] ? <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto max-h-40">{JSON.stringify(evidenceByDispute[d.id], null, 2)}</pre> : null}
            {(d.status === "RECEIVED" || d.status === "EVIDENCE_SUBMITTED") && (
              <div className="flex items-center gap-2">
                <select className="input text-xs w-auto" value={liability[d.id] ?? "AGENCY"} onChange={(e) => setLiability((prev) => ({ ...prev, [d.id]: e.target.value as never }))}>
                  <option value="OPERATOR">Operator liable</option>
                  <option value="AGENCY">Agency liable</option>
                  <option value="SHARED">Shared liability</option>
                </select>
                <button className="btn-secondary text-xs" onClick={() => resolve(d.id, "WON")}>Resolve: Won (no money moves)</button>
                <button className="btn-secondary text-xs" onClick={() => resolve(d.id, "LOST")}>Resolve: Lost (chargeback posted)</button>
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-sm text-gov-ink/60">No disputes raised.</div>}
      </div>
    </div>
  );
}
