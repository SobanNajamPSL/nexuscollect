import { useState } from "react";
import { api } from "../lib/api.js";

interface VerifyDto {
  receipt_no: string;
  agency_name: string;
  business_date: string;
  status: string;
  issued_at: string;
}

export default function Verify() {
  const [receiptNo, setReceiptNo] = useState("");
  const [result, setResult] = useState<VerifyDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await fetch(`/v1/verify/${encodeURIComponent(receiptNo)}`).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).detail ?? "Receipt not found");
        return r.json();
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Verify a receipt</h1>
        <p className="text-sm text-gov-ink/70 mt-1">No login required. Enter the receipt number printed on any NexusCollect receipt.</p>
      </div>
      <form onSubmit={handleVerify} className="card p-4 flex gap-3">
        <input className="input" value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} placeholder="e.g. PSCA20260730000000001" />
        <button className="btn" disabled={loading} type="submit">Verify</button>
      </form>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">✕ {error}</div>}

      {result && (
        <div className={`card p-6 ${result.status === "VALID" ? "border-green-300" : "border-red-300"}`}>
          <div className={`text-center font-bold text-lg ${result.status === "VALID" ? "text-green-700" : "text-red-700"}`}>
            {result.status === "VALID" ? "✓ Genuine receipt" : `✕ ${result.status}`}
          </div>
          <dl className="grid grid-cols-2 gap-y-2 text-sm mt-4">
            <dt className="text-gov-ink/60">Receipt no.</dt>
            <dd className="text-right font-medium">{result.receipt_no}</dd>
            <dt className="text-gov-ink/60">Agency</dt>
            <dd className="text-right font-medium">{result.agency_name}</dd>
            <dt className="text-gov-ink/60">Business date</dt>
            <dd className="text-right font-medium">{result.business_date}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
