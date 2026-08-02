import { useState } from "react";
import { api } from "@shared/api.js";
import { pkr, toMinor } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Head, Notice } from "../ui.js";

interface CloseResult { expected_minor: number; counted_minor: number; difference_minor: number }

/**
 * End of shift. The difference between the drawer and what the platform expects
 * posts to the ledger as a real over/short entry — it is never quietly absorbed,
 * which is the only way a cash channel stays auditable.
 */
export default function CloseTill(): JSX.Element {
  const { current } = usePersona();
  const clock = useDemoClock();
  const date = businessDate(clock);
  const isSupervisor = (current?.roles ?? []).includes("BRANCH_SUPERVISOR");

  const [counted, setCounted] = useState("");
  const [result, setResult] = useState<CloseResult | null>(null);
  const [reverseRef, setReverseRef] = useState("");
  const [reversed, setReversed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function close(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!date) return;
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await api.post<CloseResult>("/internal/till/close", { business_date: date, counted_amount_minor: toMinor(counted) }, { idempotent: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function reverse(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true); setError(null); setReversed(null);
    try {
      await api.post(`/internal/till/reverse/${encodeURIComponent(reverseRef.trim())}`, { reason: "Teller error, same session" }, { idempotent: false });
      setReversed(`${reverseRef.trim()} reversed.`);
      setReverseRef("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <div>
      <Head title="Close the till" sub={`Count the drawer and reconcile it against what the platform expects for ${date ?? "today"}.`} />

      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {reversed && <div className="mb-4"><Notice tone="good">{reversed}</Notice></div>}

      <form onSubmit={close} className="slab mb-5">
        <div className="slab-head">Cash count</div>
        <div className="p-4 space-y-4">
          <div>
            <label className="label" htmlFor="ct">Counted in the drawer (PKR)</label>
            <input id="ct" className="input text-right" type="number" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} required />
          </div>
          <button className="btn w-full" type="submit" disabled={busy}>{busy ? "Closing…" : "Close till"}</button>
        </div>
      </form>

      {result && (
        <div className="slab mb-5">
          <div className="slab-head">Reconciliation</div>
          <div className="p-4 space-y-3">
            <div className="flex items-baseline justify-between"><span className="label mb-0">Platform expects</span><span className="mid-amount">{pkr(result.expected_minor)}</span></div>
            <div className="flex items-baseline justify-between"><span className="label mb-0">You counted</span><span className="mid-amount">{pkr(result.counted_minor)}</span></div>
            <div className="border-t-2 border-fd-rule pt-3">
              {result.difference_minor === 0 ? (
                <Notice tone="good">Balanced exactly. Nothing posted.</Notice>
              ) : (
                <Notice tone={result.difference_minor > 0 ? "warn" : "bad"}>
                  {result.difference_minor > 0 ? "Over" : "Short"} by {pkr(Math.abs(result.difference_minor))} — posted to the ledger
                  as a cash over/short entry, not absorbed.
                </Notice>
              )}
            </div>
          </div>
        </div>
      )}

      <form onSubmit={reverse} className="slab">
        <div className="slab-head">Reverse a payment — supervisor only</div>
        <div className="p-4 space-y-4">
          {!isSupervisor && (
            <Notice tone="warn">
              A teller cannot reverse their own payment. Switch to a branch supervisor to approve one.
            </Notice>
          )}
          <div>
            <label className="label" htmlFor="rv">Payment reference</label>
            <input id="rv" className="input" value={reverseRef} onChange={(e) => setReverseRef(e.target.value)} disabled={!isSupervisor} />
          </div>
          <button className="btn-danger w-full" type="submit" disabled={busy || !isSupervisor || !reverseRef}>
            Reverse payment
          </button>
        </div>
      </form>
    </div>
  );
}
