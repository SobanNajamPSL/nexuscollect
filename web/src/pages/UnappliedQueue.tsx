import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface Row { payment_reference: string; amount_minor: number; value_date: string; channel: string; rail: string; remittance_raw: string | null }

export default function UnappliedQueue() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Row[]>("/internal/unapplied-receipts").then(setRows).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Unapplied receipts queue</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Real money on the balance sheet that hasn't been matched to a bill yet — the stranded-money queue.</p>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}
      <div className="card divide-y divide-gov-border">
        {rows.map((r, i) => (
          <div key={i} className="p-3 flex items-center justify-between">
            <div>
              <div className="font-medium">{r.payment_reference}</div>
              <div className="text-xs text-gov-ink/60">{r.channel} / {r.rail} — {r.value_date}{r.remittance_raw ? ` — "${r.remittance_raw}"` : ""}</div>
            </div>
            <div className="font-medium">PKR {formatPKR(r.amount_minor)}</div>
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-sm text-gov-ink/60">No unapplied receipts.</div>}
      </div>
    </div>
  );
}
