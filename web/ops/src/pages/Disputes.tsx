import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr, toMinor } from "@shared/money.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Dispute {
  id: string; payment_reference: string; scheme_reason_code: string;
  amount_minor: number; status: string; liability: string | null; created_at: string;
}

const REASONS = ["10.4 - Other Fraud", "13.1 - Merchandise/Service Not Received", "12.6.1 - Duplicate Processing", "13.6 - Credit Not Processed"];

export default function Disputes(): JSX.Element {
  const [rows, setRows] = useState<Dispute[]>([]);
  const [ref, setRef] = useState("");
  const [reason, setReason] = useState(REASONS[0]!);
  const [amountPkr, setAmountPkr] = useState("");
  const [liability, setLiability] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await api.get<Dispute[]>("/internal/disputes")); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function raise(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy("create"); setError(null); setDone(null);
    try {
      await api.post("/internal/disputes", { payment_reference: ref, scheme_reason_code: reason, amount_minor: toMinor(amountPkr) });
      setRef(""); setAmountPkr("");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }

  async function bundle(d: Dispute): Promise<void> {
    setBusy(d.id); setError(null);
    try {
      const res = await api.post<{ evidence_bundle: unknown }>(`/internal/disputes/${d.id}/evidence`, {});
      setEvidence({ ...evidence, [d.id]: res.evidence_bundle });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }

  async function resolve(d: Dispute, outcome: "WON" | "LOST"): Promise<void> {
    setBusy(d.id); setError(null); setDone(null);
    try {
      await api.post(`/internal/disputes/${d.id}/resolve`, { outcome, liability: liability[d.id] ?? "AGENCY" });
      setDone(outcome === "WON" ? "Dispute won — no money moves." : "Dispute lost — a chargeback has been posted to the ledger.");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }

  return (
    <div>
      <PageHead
        title="Disputes & chargebacks"
        note="Cards are the one rail where a citizen can reverse a completed payment weeks later, through the scheme rather than through us. The strongest evidence is proof the government service was actually delivered — which only the agency can supply."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <form onSubmit={raise} className="panel p-3 mb-3 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <label className="label" htmlFor="dref">Card payment reference</label>
          <input id="dref" className="input" value={ref} onChange={(e) => setRef(e.target.value)} required />
        </div>
        <div className="w-72">
          <label className="label" htmlFor="drsn">Scheme reason code</label>
          <select id="drsn" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="w-40">
          <label className="label" htmlFor="damt">Amount (PKR)</label>
          <input id="damt" className="input text-right tabular-nums" type="number" step="0.01" value={amountPkr} onChange={(e) => setAmountPkr(e.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={busy !== null}>Raise dispute</button>
      </form>

      <div className="panel">
        <div className="panel-head">Disputes — {rows.length}</div>
        {rows.length === 0 ? <Empty>No disputes raised.</Empty> : (
          <table className="grid-table">
            <thead>
              <tr><th>Payment</th><th>Reason</th><th className="num">Amount</th><th>Status</th><th>Liability</th><th style={{ width: "22rem" }}>Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="ref font-semibold">{d.payment_reference}</td>
                  <td className="text-[11px]">{d.scheme_reason_code}</td>
                  <td className="num">{pkr(d.amount_minor)}</td>
                  <td><Status value={d.status} /></td>
                  <td>{d.liability ?? <span className="text-op-inkDim">—</span>}</td>
                  <td>
                    {d.status === "WON" || d.status === "LOST" ? <span className="text-op-inkDim">Closed</span> : (
                      <div className="space-y-1">
                        <div className="flex gap-1">
                          <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => bundle(d)}>Assemble evidence</button>
                          <select className="select w-28" value={liability[d.id] ?? "AGENCY"} onChange={(e) => setLiability({ ...liability, [d.id]: e.target.value })}>
                            <option value="OPERATOR">Operator</option>
                            <option value="AGENCY">Agency</option>
                            <option value="SHARED">Shared</option>
                          </select>
                        </div>
                        <div className="flex gap-1">
                          <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => resolve(d, "WON")}>Won</button>
                          <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => resolve(d, "LOST")}>Lost</button>
                        </div>
                        {evidence[d.id] !== undefined && (
                          <pre className="text-[10px] font-mono bg-op-panelAlt border border-op-rule rounded p-1.5 max-h-32 overflow-auto">
                            {JSON.stringify(evidence[d.id], null, 1)}
                          </pre>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
