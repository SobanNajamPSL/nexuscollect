import { useState } from "react";
import { api } from "@shared/api.js";
import { pkr, toMinor } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Head, Notice } from "../ui.js";

const TYPES = [
  { value: "CHEQUE", label: "Cheque" },
  { value: "POST_DATED_CHEQUE", label: "Post-dated cheque" },
  { value: "PAY_ORDER", label: "Pay order" },
  { value: "DEMAND_DRAFT", label: "Demand draft" },
];

interface Lodged { instrument_id: string; payment_id: string; provisional: boolean; credit_policy: string }

/**
 * Accepting a physical instrument. The critical thing the teller must be told,
 * clearly, is that this money is *not final* — the bank can still return it, so
 * it cannot reach treasury and the payer's obligation is only provisionally
 * discharged.
 */
export default function LodgeCheque(): JSX.Element {
  const { current } = usePersona();
  const clock = useDemoClock();
  const date = businessDate(clock);
  const isTeller = (current?.roles ?? []).includes("TELLER");

  const [type, setType] = useState(TYPES[0]!.value);
  const [number, setNumber] = useState("");
  const [bank, setBank] = useState("");
  const [drawer, setDrawer] = useState("");
  const [psid, setPsid] = useState("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<Lodged | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lodge(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!date) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const minor = toMinor(amount);
      setResult(await api.post<Lodged>("/internal/instruments", {
        instrument_type: type,
        instrument_number: number.trim(),
        amount_minor: minor,
        drawee_bank_name: bank || undefined,
        drawer_name: drawer || undefined,
        allocations: [{ psid: psid.trim(), amount_minor: minor }],
        value_date: date,
      }));
      setNumber(""); setPsid(""); setAmount(""); setDrawer("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <div>
      <Head title="Lodge a cheque" sub="A cheque, pay order or demand draft handed across the counter, tendered against a bill." />

      {!isTeller && (
        <div className="mb-4">
          <Notice tone="warn">
            Only a teller may accept a payment. A branch supervisor approves reversals and closes the till, but cannot take money in.
          </Notice>
        </div>
      )}

      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}

      {result && (
        <div className="mb-5 space-y-3">
          <Notice tone="good">Instrument lodged and linked to the bill.</Notice>
          <Notice tone="warn">
            This money is <strong>provisional</strong> — credit policy {result.credit_policy.replace(/_/g, " ").toLowerCase()}.
            The bill shows paid, but the funds cannot be transferred to treasury until the bank clears the instrument, and if it
            bounces every effect is unwound.
          </Notice>
        </div>
      )}

      <form onSubmit={lodge} className="slab">
        <div className="slab-head">Instrument details</div>
        <div className="p-4 space-y-4">
          <div>
            <label className="label" htmlFor="ty">Type</label>
            <select id="ty" className="input" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="no">Instrument number</label>
            <input id="no" className="input" value={number} onChange={(e) => setNumber(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="bk">Drawee bank</label>
            <input id="bk" className="input" value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Habib Bank Limited" />
          </div>
          <div>
            <label className="label" htmlFor="dr">Drawer name</label>
            <input id="dr" className="input" value={drawer} onChange={(e) => setDrawer(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="ps">Bill reference (PSID)</label>
            <input id="ps" className="input" value={psid} onChange={(e) => setPsid(e.target.value)} inputMode="numeric" required />
          </div>
          <div>
            <label className="label" htmlFor="am">Amount on the instrument (PKR)</label>
            <input id="am" className="input text-right" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            <p className="text-sm text-fd-inkDim mt-1.5">
              Must match what is tendered against the bill exactly — a part-allocated instrument is refused.
            </p>
          </div>
          <button className="btn w-full" type="submit" disabled={busy || !isTeller}>
            {busy ? "Lodging…" : amount ? `Lodge ${pkr(toMinor(amount))} — provisionally` : "Lodge instrument"}
          </button>
        </div>
      </form>
    </div>
  );
}
