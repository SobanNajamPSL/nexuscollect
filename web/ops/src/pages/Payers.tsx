import { useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Field, Notice, PageHead, Status } from "../ui.js";

interface Hit { id: string; name: string; payer_type: string; msisdn_e164: string | null }
interface Payer360 {
  payer_id: string; name: string; payer_type: string; risk_rating: string;
  accounts: { agency_code: string; crn: string; status: string }[];
  assessments: { psid: string; status: string; balance_minor: number }[];
  payments: { payment_reference: string; status: string; gross_amount_minor: number }[];
  refunds: { refund_reference: string; status: string; amount_minor: number }[];
  mandates: { id: string; mandate_reference: string; status: string; max_amount_minor: number }[];
}

/**
 * The cross-agency view of one payer — everything they owe and have paid, across
 * every agency on the platform. This is deliberately operator-only: an agency
 * seeing a payer's dealings with *other* agencies would breach the tenant
 * boundary, so the agency portal carries a scoped version instead.
 */
export default function Payers(): JSX.Element {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [data, setData] = useState<Payer360 | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    setError(null); setData(null);
    try { setHits(await api.get<Hit[]>(`/internal/payers/search?q=${encodeURIComponent(q)}`)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function open(id: string): Promise<void> {
    setError(null);
    try { setData(await api.get<Payer360>(`/internal/payers/${id}/360`)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  return (
    <div>
      <PageHead title="Payer 360°" note="One person or company, across every agency. Cross-tenant by design — this is the view an agency deliberately cannot have." />

      {error && <Notice tone="bad">{error}</Notice>}

      <form className="panel p-3 mb-3 flex items-end gap-3" onSubmit={search}>
        <div className="flex-1 max-w-md">
          <label className="label" htmlFor="pq">Payer name</label>
          <input id="pq" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ahmed" />
        </div>
        <button className="btn" type="submit">Search</button>
      </form>

      {hits && !data && (
        <div className="panel">
          <div className="panel-head">Matches — {hits.length}</div>
          {hits.length === 0 ? <Empty>No payer matches.</Empty> : (
            <table className="grid-table">
              <thead><tr><th>Name</th><th>Type</th><th>Contact</th></tr></thead>
              <tbody>
                {hits.map((h) => (
                  <tr key={h.id} className="cursor-pointer" onClick={() => open(h.id)}>
                    <td className="font-semibold text-op-primary">{h.name}</td>
                    <td>{h.payer_type.replace(/_/g, " ")}</td>
                    <td className="ref">{h.msisdn_e164 ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {data && (
        <div className="space-y-3">
          <button className="btn-secondary btn-xs" onClick={() => setData(null)}>← Back</button>

          <section className="panel">
            <div className="panel-head">{data.name}</div>
            <div className="p-3 grid grid-cols-4 gap-4">
              <Field label="Type">{data.payer_type.replace(/_/g, " ")}</Field>
              <Field label="Risk rating">
                {data.risk_rating}
                <div className="text-[10px] text-op-inkDim">loaded, not computed — risk scoring is out of scope in this build</div>
              </Field>
              <Field label="Accounts">{data.accounts.length}</Field>
              <Field label="Standing mandates">{data.mandates.length}</Field>
            </div>
          </section>

          <div className="grid grid-cols-2 gap-3 items-start">
            <section className="panel">
              <div className="panel-head">Accounts across agencies</div>
              {data.accounts.length === 0 ? <Empty>None.</Empty> : (
                <table className="grid-table">
                  <thead><tr><th>Agency</th><th>Reference</th><th>Status</th></tr></thead>
                  <tbody>{data.accounts.map((a, i) => (
                    <tr key={i}><td className="font-semibold">{a.agency_code}</td><td className="ref">{a.crn}</td><td><Status value={a.status} /></td></tr>
                  ))}</tbody>
                </table>
              )}
            </section>
            <section className="panel">
              <div className="panel-head">Standing mandates</div>
              {data.mandates.length === 0 ? <Empty>No mandates.</Empty> : (
                <table className="grid-table">
                  <thead><tr><th>Reference</th><th className="num">Max per collection</th><th>Status</th></tr></thead>
                  <tbody>{data.mandates.map((m) => (
                    <tr key={m.id}><td className="ref">{m.mandate_reference}</td><td className="num">{pkr(m.max_amount_minor)}</td><td><Status value={m.status} /></td></tr>
                  ))}</tbody>
                </table>
              )}
            </section>
          </div>

          <section className="panel">
            <div className="panel-head">Bills — {data.assessments.length}</div>
            <table className="grid-table">
              <thead><tr><th>PSID</th><th>Status</th><th className="num">Outstanding</th></tr></thead>
              <tbody>{data.assessments.map((a, i) => (
                <tr key={i}><td className="ref">{a.psid}</td><td><Status value={a.status} /></td><td className="num">{pkr(a.balance_minor)}</td></tr>
              ))}</tbody>
            </table>
          </section>

          <div className="grid grid-cols-2 gap-3 items-start">
            <section className="panel">
              <div className="panel-head">Payments — {data.payments.length}</div>
              <table className="grid-table">
                <thead><tr><th>Reference</th><th className="num">Amount</th><th>Status</th></tr></thead>
                <tbody>{data.payments.map((p, i) => (
                  <tr key={i}><td className="ref">{p.payment_reference}</td><td className="num">{pkr(p.gross_amount_minor)}</td><td><Status value={p.status} /></td></tr>
                ))}</tbody>
              </table>
            </section>
            <section className="panel">
              <div className="panel-head">Refunds — {data.refunds.length}</div>
              {data.refunds.length === 0 ? <Empty>No refunds.</Empty> : (
                <table className="grid-table">
                  <thead><tr><th>Reference</th><th className="num">Amount</th><th>Status</th></tr></thead>
                  <tbody>{data.refunds.map((r, i) => (
                    <tr key={i}><td className="ref">{r.refund_reference}</td><td className="num">{pkr(r.amount_minor)}</td><td><Status value={r.status} /></td></tr>
                  ))}</tbody>
                </table>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
