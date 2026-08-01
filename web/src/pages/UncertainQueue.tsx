import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface Row { payment_reference: string; gross_amount_minor: number; channel: string; rail: string; received_at: string; uncertain_resolution_source: string | null }

const SOURCES = ["RAIL_STATUS_ENQUIRY", "AGGREGATOR_ADVICE", "INTRADAY_STATEMENT", "EOD_STATEMENT", "HUMAN_INVESTIGATION"];

export default function UncertainQueue() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      setRows(await api.get<Row[]>("/internal/payments/uncertain"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function resolve(ref: string, outcome: "FOUND_PAID" | "FOUND_NOT_PAID", source: string) {
    setBusy(ref);
    setError(null);
    try {
      await api.post(`/internal/payments/${encodeURIComponent(ref)}/resolve-uncertain`, { outcome, source }, { idempotent: false });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">UNCERTAIN payments queue</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Never shown to the payer as failed (§9.4) — resolved here via the same five escalation strategies the resolver uses.</p>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}
      <div className="card divide-y divide-gov-border">
        {rows.map((r) => (
          <div key={r.payment_reference} className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{r.payment_reference}</div>
                <div className="text-xs text-gov-ink/60">{r.channel} / {r.rail} — received {new Date(r.received_at).toLocaleString()}</div>
              </div>
              <div className="font-medium">PKR {formatPKR(r.gross_amount_minor)}</div>
            </div>
            <div className="flex gap-2 mt-2">
              <button disabled={busy === r.payment_reference} className="btn text-xs" onClick={() => resolve(r.payment_reference, "FOUND_PAID", SOURCES[0]!)}>Found paid (rail enquiry)</button>
              <button disabled={busy === r.payment_reference} className="btn-secondary text-xs" onClick={() => resolve(r.payment_reference, "FOUND_NOT_PAID", "HUMAN_INVESTIGATION")}>Found not paid</button>
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-sm text-gov-ink/60">No UNCERTAIN payments — queue is empty.</div>}
      </div>
    </div>
  );
}
