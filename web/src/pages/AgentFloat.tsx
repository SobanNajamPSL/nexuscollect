import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface FloatPosition { agent_code: string; collected_minor: number; remitted_minor: number; outstanding_minor: number }

export default function AgentFloat() {
  const [agentCode, setAgentCode] = useState("AGT-001");
  const [agentName, setAgentName] = useState("Zaman General Store");
  const [psid, setPsid] = useState("");
  const [amountPkr, setAmountPkr] = useState("");
  const [remitAmountPkr, setRemitAmountPkr] = useState("");
  const [position, setPosition] = useState<FloatPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function loadPosition() {
    setError(null);
    try {
      setPosition(await api.get<FloatPosition>(`/internal/agents/${agentCode}/float`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function capture(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ payment_id: string; status: string }>("/internal/payments/agent", {
        agent_code: agentCode, agent_name: agentName, psid, amount_minor: Math.round(Number(amountPkr) * 100), value_date: "2026-07-30",
      });
      setResult(`Collected — payment ${res.payment_id} (${res.status}). This citizen's payment is final; only the agent's own float now reflects an amount owed back to the operator.`);
      setPsid(""); setAmountPkr("");
      await loadPosition();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/internal/agents/${agentCode}/remit`, { amount_minor: Math.round(Number(remitAmountPkr) * 100), business_date: "2026-07-30" });
      setRemitAmountPkr("");
      await loadPosition();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Agent / Branchless Banking</h1>
        <p className="text-sm text-gov-ink/70 mt-1">An agent is not a branch — cash collected against a bill goes through the same capture pipeline as every other channel, but a separate float reconciliation tracks what the agent now owes the operator.</p>
      </div>

      <div className="card p-4 grid grid-cols-2 gap-3">
        <input className="input" value={agentCode} onChange={(e) => setAgentCode(e.target.value)} placeholder="Agent code" />
        <input className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Agent name" />
        <button className="btn-secondary col-span-2" type="button" onClick={loadPosition}>Load float position</button>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}
      {result && <div className="card p-4 bg-green-50 border-green-300 text-green-800 text-sm">{result}</div>}

      {position && (
        <div className="card p-4 grid grid-cols-3 gap-4 text-center">
          <div><div className="text-xs text-gov-ink/60">Collected</div><div className="text-lg font-bold">PKR {formatPKR(position.collected_minor)}</div></div>
          <div><div className="text-xs text-gov-ink/60">Remitted</div><div className="text-lg font-bold">PKR {formatPKR(position.remitted_minor)}</div></div>
          <div><div className="text-xs text-gov-ink/60">Outstanding (owed to operator)</div><div className="text-lg font-bold">PKR {formatPKR(position.outstanding_minor)}</div></div>
        </div>
      )}

      <form onSubmit={capture} className="card p-4 space-y-3">
        <div className="font-semibold text-sm">Collect a citizen payment (over the counter, at the agent)</div>
        <div className="grid grid-cols-2 gap-3">
          <input className="input" value={psid} onChange={(e) => setPsid(e.target.value)} placeholder="PSID" required />
          <input className="input" type="number" step="0.01" value={amountPkr} onChange={(e) => setAmountPkr(e.target.value)} placeholder="Amount (PKR)" required />
        </div>
        <button className="btn" type="submit">Collect cash</button>
      </form>

      <form onSubmit={remit} className="card p-4 space-y-3">
        <div className="font-semibold text-sm">Record a remittance (agent hands cash back to the operator)</div>
        <div className="flex gap-3">
          <input className="input flex-1" type="number" step="0.01" value={remitAmountPkr} onChange={(e) => setRemitAmountPkr(e.target.value)} placeholder="Remitted amount (PKR)" required />
          <button className="btn-secondary" type="submit">Record remittance</button>
        </div>
      </form>
    </div>
  );
}
