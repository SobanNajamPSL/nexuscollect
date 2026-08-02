import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr, toMinor } from "@shared/money.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Head, Notice } from "../ui.js";

interface Position { agent_code: string; collected_minor: number; remitted_minor: number; outstanding_minor: number }

/**
 * An agent is not a branch.
 *
 * A citizen's bill is discharged the instant the agent accepts the cash —
 * surcharge stops, the bill shows paid, a receipt exists. What the agent then
 * owes the operator is a separate, parallel reconciliation, and the outstanding
 * figure is always derived from the movements rather than kept as a running
 * balance, so it cannot drift.
 */
export default function AgentFloat(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const [agentCode, setAgentCode] = useState("AGT-001");
  const [agentName, setAgentName] = useState("Zaman General Store");
  const [position, setPosition] = useState<Position | null>(null);
  const [psid, setPsid] = useState("");
  const [amount, setAmount] = useState("");
  const [remit, setRemit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setPosition(await api.get<Position>(`/internal/agents/${agentCode}/float`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [agentCode]);

  useEffect(() => { void load(); }, [load]);

  async function collect(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!date) return;
    setBusy(true); setError(null); setDone(null);
    try {
      await api.post("/internal/payments/agent", {
        agent_code: agentCode, agent_name: agentName, psid: psid.trim(), amount_minor: toMinor(amount), value_date: date,
      });
      setDone("Cash collected. The citizen's bill is settled now — only your float still shows an amount owed to the operator.");
      setPsid(""); setAmount("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function handRemit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!date) return;
    setBusy(true); setError(null); setDone(null);
    try {
      await api.post(`/internal/agents/${agentCode}/remit`, { amount_minor: toMinor(remit), business_date: date });
      setDone("Remittance recorded.");
      setRemit("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <div>
      <Head title="Agent float" sub="For a shop or kiosk collecting on the platform's behalf." />

      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {done && <div className="mb-4"><Notice tone="good">{done}</Notice></div>}

      <div className="slab mb-5">
        <div className="slab-head">Agent</div>
        <div className="p-4 grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="ac">Code</label>
            <input id="ac" className="input" value={agentCode} onChange={(e) => setAgentCode(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="an">Name</label>
            <input id="an" className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
          </div>
        </div>
      </div>

      {position && (
        <div className="slab mb-5">
          <div className="slab-head">Float position</div>
          <div className="p-4 grid grid-cols-3 gap-4 text-center">
            <div><div className="label">Collected</div><div className="mid-amount">{pkr(position.collected_minor)}</div></div>
            <div><div className="label">Remitted</div><div className="mid-amount">{pkr(position.remitted_minor)}</div></div>
            <div>
              <div className="label text-fd-accent">Owed to operator</div>
              <div className="big-amount text-fd-accent">{pkr(position.outstanding_minor)}</div>
            </div>
          </div>
          <div className="px-4 pb-4 text-sm text-fd-inkDim">
            Always collected minus remitted, recomputed from the movements — never a stored running total.
          </div>
        </div>
      )}

      <form onSubmit={collect} className="slab mb-5">
        <div className="slab-head">Collect cash for a bill</div>
        <div className="p-4 space-y-4">
          <div>
            <label className="label" htmlFor="ps">Bill reference (PSID)</label>
            <input id="ps" className="input" value={psid} onChange={(e) => setPsid(e.target.value)} inputMode="numeric" required />
          </div>
          <div>
            <label className="label" htmlFor="am">Amount (PKR)</label>
            <input id="am" className="input text-right" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <button className="btn w-full" type="submit" disabled={busy}>{busy ? "Collecting…" : "Collect cash"}</button>
        </div>
      </form>

      <form onSubmit={handRemit} className="slab">
        <div className="slab-head">Hand cash back to the operator</div>
        <div className="p-4 space-y-4">
          <div>
            <label className="label" htmlFor="rm">Remitted (PKR)</label>
            <input id="rm" className="input text-right" type="number" step="0.01" value={remit} onChange={(e) => setRemit(e.target.value)} required />
          </div>
          <button className="btn-secondary w-full" type="submit" disabled={busy}>Record remittance</button>
        </div>
      </form>
    </div>
  );
}
