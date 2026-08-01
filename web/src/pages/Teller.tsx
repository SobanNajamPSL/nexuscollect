import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

export default function Teller() {
  const [psid, setPsid] = useState("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [reverseRef, setReverseRef] = useState("");
  const [counted, setCounted] = useState("");
  const [closeResult, setCloseResult] = useState<{ expected_minor: number; counted_minor: number; difference_minor: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function captureCash() {
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ payment_id: string; status: string; settled_assessment_ids: string[] }>("/internal/till/capture-cash", { psid, amount_minor: Math.round(Number(amount) * 100), value_date: "2026-07-30" }, { idempotent: false });
      setResult(`Payment ${res.status} — ${res.settled_assessment_ids.length} assessment(s) settled.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function reverse() {
    setError(null);
    try {
      await api.post(`/internal/till/reverse/${encodeURIComponent(reverseRef)}`, { reason: "Teller keying error" }, { idempotent: false });
      setResult(`${reverseRef} reversed.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function closeTill() {
    setError(null);
    try {
      setCloseResult(await api.post("/internal/till/close", { business_date: "2026-07-30", counted_amount_minor: Math.round(Number(counted) * 100) }, { idempotent: false }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Teller / till</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Accept cash payments, reverse a keying error, close the till with over/short posted to the real ledger.</p>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}
      {result && <div className="card p-4 bg-green-50 border-green-300 text-green-800 text-sm">{result}</div>}

      <div className="card p-4 space-y-3">
        <div className="font-semibold">Accept cash payment</div>
        <div className="grid grid-cols-2 gap-3">
          <input className="input" placeholder="PSID" value={psid} onChange={(e) => setPsid(e.target.value)} />
          <input className="input" placeholder="Amount (PKR)" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <button className="btn" onClick={captureCash}>Capture cash</button>
      </div>

      <div className="card p-4 space-y-3">
        <div className="font-semibold">Reverse (same-day keying error)</div>
        <input className="input" placeholder="Payment reference" value={reverseRef} onChange={(e) => setReverseRef(e.target.value)} />
        <button className="btn-secondary" onClick={reverse}>Reverse</button>
      </div>

      <div className="card p-4 space-y-3">
        <div className="font-semibold">Close till</div>
        <input className="input" placeholder="Counted cash (PKR)" value={counted} onChange={(e) => setCounted(e.target.value)} />
        <button className="btn" onClick={closeTill}>Close till</button>
        {closeResult && (
          <div className="text-sm">
            Expected PKR {formatPKR(closeResult.expected_minor)} — Counted PKR {formatPKR(closeResult.counted_minor)} —{" "}
            <span className={closeResult.difference_minor === 0 ? "text-green-700" : "text-red-700"}>
              {closeResult.difference_minor === 0 ? "Balanced" : `${closeResult.difference_minor > 0 ? "Over" : "Short"} by PKR ${formatPKR(Math.abs(closeResult.difference_minor))}`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
