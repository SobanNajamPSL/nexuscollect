import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Assessment360 {
  psid: string; current_version: number; status: string;
  versions: { version: number; status: string; assessed_amount_minor: number; payable_amount_minor: number; allocated_amount_minor: number; balance_minor: number }[];
  line_items: { head_code: string; line_type: string; amount_minor: number; allocated_minor: number }[];
  payment_history: { payment_reference: string; amount_minor: number; status: string; payment_status: string }[];
  notifications: { event_type: string; channel: string; status: string; sent_at: string }[];
}

export default function Assessments(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [psid, setPsid] = useState(params.get("psid") ?? "");
  const [data, setData] = useState<Assessment360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setError(null);
    try { setData(await api.get<Assessment360>(`/internal/assessments/${encodeURIComponent(id)}/360`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setData(null); }
  }, []);

  useEffect(() => {
    const initial = params.get("psid");
    if (initial) void load(initial);
  }, [params, load]);

  async function deposit(paymentReference: string, action: "refund" | "forfeit" | "convert"): Promise<void> {
    setBusy(true); setError(null); setDone(null);
    try {
      if (action === "refund") {
        await api.post(`/internal/deposits/${paymentReference}/refund`, {});
        setDone(`${paymentReference}: deposit returned to the depositor.`);
      } else {
        await api.post(`/internal/deposits/${paymentReference}/exit`, { exit: action === "forfeit" ? "FORFEITED" : "CONVERTED_TO_REVENUE" });
        setDone(`${paymentReference}: deposit ${action === "forfeit" ? "forfeited" : "converted to agency revenue"}.`);
      }
      await load(psid);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <PageHead title="Assessment 360°" note="One bill's whole history across every version — what was assessed, what was paid against which head, and what the payer was told. Cross-agency: an agency sees only its own." />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <form className="panel p-3 mb-3 flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); setParams({ psid }); void load(psid); }}>
        <div className="flex-1 max-w-md">
          <label className="label" htmlFor="ps">PSID</label>
          <input id="ps" className="input" value={psid} onChange={(e) => setPsid(e.target.value)} placeholder="12010100001359715" />
        </div>
        <button className="btn" type="submit">Look up</button>
      </form>

      {data && (
        <div className="space-y-3">
          <section className="panel">
            <div className="panel-head flex items-center justify-between">
              <span className="ref normal-case tracking-normal text-[13px] font-bold">{data.psid}</span>
              <span><Status value={data.status} /> <span className="text-op-inkDim">v{data.current_version}</span></span>
            </div>
            <table className="grid-table">
              <thead><tr><th>Version</th><th>Status</th><th className="num">Assessed</th><th className="num">Payable</th><th className="num">Paid</th><th className="num">Outstanding</th></tr></thead>
              <tbody>{data.versions.map((v) => (
                <tr key={v.version} className={v.version === data.current_version ? "bg-op-primary/[0.04]" : ""}>
                  <td className="tabular-nums">{v.version}</td>
                  <td><Status value={v.status} /></td>
                  <td className="num">{pkr(v.assessed_amount_minor)}</td>
                  <td className="num">{pkr(v.payable_amount_minor)}</td>
                  <td className="num">{pkr(v.allocated_amount_minor)}</td>
                  <td className="num">{pkr(v.balance_minor)}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>

          <div className="grid grid-cols-2 gap-3 items-start">
            <section className="panel">
              <div className="panel-head">Line items — head-wise</div>
              <table className="grid-table">
                <thead><tr><th>Head</th><th>Type</th><th className="num">Amount</th><th className="num">Paid</th></tr></thead>
                <tbody>{data.line_items.map((l, i) => (
                  <tr key={i}><td className="ref">{l.head_code}</td><td>{l.line_type}</td><td className="num">{pkr(l.amount_minor)}</td><td className="num">{pkr(l.allocated_minor)}</td></tr>
                ))}</tbody>
              </table>
            </section>

            <section className="panel">
              <div className="panel-head">Payments received</div>
              {data.payment_history.length === 0 ? <Empty>Nothing received.</Empty> : (
                <table className="grid-table">
                  <thead><tr><th>Payment</th><th className="num">Amount</th><th>Allocation</th><th>If a refundable deposit</th></tr></thead>
                  <tbody>{data.payment_history.map((p, i) => (
                    <tr key={i}>
                      <td className="ref">{p.payment_reference}</td>
                      <td className="num">{pkr(p.amount_minor)}</td>
                      <td><Status value={p.status} /></td>
                      <td>
                        {p.payment_status === "CONFIRMED" ? (
                          <span className="flex gap-1">
                            <button className="btn-secondary btn-xs" disabled={busy} onClick={() => deposit(p.payment_reference, "refund")}>Refund</button>
                            <button className="btn-secondary btn-xs" disabled={busy} onClick={() => deposit(p.payment_reference, "forfeit")}>Forfeit</button>
                            <button className="btn-secondary btn-xs" disabled={busy} onClick={() => deposit(p.payment_reference, "convert")}>To revenue</button>
                          </span>
                        ) : <span className="text-op-inkDim">—</span>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </section>
          </div>

          <section className="panel">
            <div className="panel-head">Notifications sent to the payer</div>
            {data.notifications.length === 0 ? <Empty>None sent.</Empty> : (
              <table className="grid-table">
                <thead><tr><th>Event</th><th>Channel</th><th>Status</th><th>When</th></tr></thead>
                <tbody>{data.notifications.map((n, i) => (
                  <tr key={i}><td>{n.event_type}</td><td>{n.channel}</td><td><Status value={n.status} /></td><td className="text-[11px] text-op-inkDim">{new Date(n.sent_at).toLocaleString()}</td></tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
