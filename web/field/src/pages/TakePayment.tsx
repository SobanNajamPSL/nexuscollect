import { useState } from "react";
import { api } from "@shared/api.js";
import { pkr, splitCashTender, toMinor } from "@shared/money.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Head, Notice } from "../ui.js";

interface Payable { psid: string; label: string; agency_name: string; payable_amount_minor: number; status: string }
interface Resolved { payables: Payable[] }

/**
 * Cash over the counter. The teller captures on the citizen's behalf, and it
 * runs through the same pipeline as every other channel — nothing in the ledger
 * treats counter cash as a special case, which is exactly the point.
 */
export default function TakePayment(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const [reference, setReference] = useState("");
  const [payables, setPayables] = useState<Payable[] | null>(null);
  const [tendered, setTendered] = useState("");
  const [selected, setSelected] = useState<Payable | null>(null);
  const [receipt, setReceipt] = useState<{ payment_id: string; settled: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null); setPayables(null); setSelected(null); setReceipt(null);
    setBusy(true);
    try {
      const res = await api.post<Resolved>("/v1/resolve", { key_type: "PSID", key_value: reference.trim(), channel: "OTC_CASH" }, { idempotent: false });
      setPayables(res.payables);
      if (res.payables.length === 1) { setSelected(res.payables[0]!); setTendered((res.payables[0]!.payable_amount_minor / 100).toFixed(2)); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function take(): Promise<void> {
    if (!selected || !date) return;
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ payment_id: string; settled_assessment_ids: string[] }>("/internal/till/capture-cash", {
        psid: selected.psid, amount_minor: capturedMinor, value_date: date,
      }, { idempotent: false });
      setReceipt({ payment_id: res.payment_id, settled: res.settled_assessment_ids.length });
      setPayables(null); setSelected(null); setReference("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  // The rule lives in `@shared/money` so it is unit-tested rather than trusted:
  // capturing the tendered figure instead of the amount kept was a real defect.
  const dueMinor = selected?.payable_amount_minor ?? 0;
  const { capturedMinor, changeMinor: change, shortByMinor: shortBy } = splitCashTender(tendered ? toMinor(tendered) : 0, dueMinor);

  return (
    <div>
      <Head title="Take a payment" sub="Cash across the counter. Read the amount back to the payer before you accept it." />

      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {receipt && (
        <div className="mb-5">
          <Notice tone="good">
            Payment accepted. {receipt.settled} bill{receipt.settled === 1 ? "" : "s"} settled — print the receipt for the payer.
          </Notice>
        </div>
      )}

      <form onSubmit={lookup} className="slab mb-5">
        <div className="slab-head">Find the bill</div>
        <div className="p-4 space-y-4">
          <div>
            <label className="label" htmlFor="ref">Bill reference (PSID)</label>
            <input id="ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} inputMode="numeric" placeholder="31010900000181526" required />
          </div>
          <button className="btn w-full" type="submit" disabled={busy}>{busy ? "Looking up…" : "Look up"}</button>
        </div>
      </form>

      {payables && payables.length === 0 && <Notice tone="warn">Nothing outstanding against that reference.</Notice>}

      {payables && payables.length > 0 && (
        <div className="slab mb-5">
          <div className="slab-head">Owing — {payables.length}</div>
          <div className="divide-y-2 divide-fd-rule">
            {payables.map((p) => (
              <button
                key={p.psid}
                type="button"
                onClick={() => { setSelected(p); setTendered((p.payable_amount_minor / 100).toFixed(2)); }}
                className={`w-full text-left p-4 ${selected?.psid === p.psid ? "bg-fd-primary/[0.08]" : "hover:bg-fd-panelAlt"}`}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <div>
                    <div className="font-bold">{p.label}</div>
                    <div className="text-sm text-fd-inkDim">{p.agency_name}</div>
                  </div>
                  <div className="mid-amount whitespace-nowrap">{pkr(p.payable_amount_minor)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <div className="slab">
          <div className="slab-head">Accept cash</div>
          <div className="p-4 space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="label mb-0">Amount due</span>
              <span className="big-amount">{pkr(selected.payable_amount_minor)}</span>
            </div>
            <div>
              <label className="label" htmlFor="tend">Cash tendered (PKR)</label>
              <input id="tend" className="input text-right" type="number" step="0.01" value={tendered} onChange={(e) => setTendered(e.target.value)} />
            </div>
            {change > 0 && (
              <div className="flex items-baseline justify-between text-fd-accent">
                <span className="label mb-0 text-fd-accent">Change to return</span>
                <span className="mid-amount">{pkr(change)}</span>
              </div>
            )}
            {shortBy > 0 && <Notice tone="warn">Short by {pkr(shortBy)} — this will be a partial payment if the product allows one.</Notice>}
            <button className="btn w-full" onClick={take} disabled={busy || !tendered}>
              {busy ? "Accepting…" : `Accept ${pkr(capturedMinor)} cash`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
