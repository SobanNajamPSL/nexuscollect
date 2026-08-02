import { useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Field, Notice, PageHead, Status } from "../ui.js";

interface SearchRow {
  id: string;
  payment_reference: string;
  status: string;
  gross_amount_minor: number;
  channel: string;
  rail: string;
  value_date: string;
}
interface Payment360 {
  payment_reference: string;
  status: string;
  gross_amount_minor: number;
  unapplied_amount_minor: number;
  channel: string;
  rail: string;
  value_date: string;
  obligation_discharge_date: string;
  finality: string;
  application_trace: unknown;
  allocations: { psid: string; head_code: string; amount_minor: number; status: string }[];
  journal_entries: { entry_no: number; event_type: string; account_code: string; direction: string; amount_minor: number }[];
  receipt: { receipt_no: string; status: string } | null;
  recon_breaks: { break_code: string; status: string; amount_minor: number }[];
  third_party_payer: { name: string; maskedId: string; relationship: string } | null;
}

export default function Payments(): JSX.Element {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [detail, setDetail] = useState<Payment360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recall, setRecall] = useState<{ outcome: string; camt029_reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    setError(null);
    setDetail(null);
    try {
      setRows(await api.get<SearchRow[]>(`/internal/payments/search?q=${encodeURIComponent(q)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function open(ref: string): Promise<void> {
    setError(null);
    setRecall(null);
    try {
      setDetail(await api.get<Payment360>(`/internal/payments/${encodeURIComponent(ref)}/360`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function requestRecall(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      setRecall(
        await api.post<{ outcome: string; camt029_reason: string | null }>("/internal/recalls", {
          payment_reference: detail.payment_reference,
          requested_reason: "SENDING_BANK_REQUEST",
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHead
        title="Payment 360°"
        note="Everything the platform knows about one payment: what it was applied to, the journal entries it posted, the receipt it produced, any reconciliation break against it, and the full replayable trace of how it was applied."
      />

      {error && <Notice tone="bad">{error}</Notice>}

      <form className="panel p-3 mb-3 flex items-end gap-3" onSubmit={search}>
        <div className="flex-1 max-w-xl">
          <label className="label" htmlFor="q">
            Payment reference, rail end-to-end id, or switch STAN
          </label>
          <input id="q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="P260000E" />
        </div>
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      {rows && !detail && (
        <div className="panel">
          <div className="panel-head">Results — {rows.length}</div>
          {rows.length === 0 ? (
            <Empty>Nothing matches.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Channel / rail</th>
                  <th>Value date</th>
                  <th className="num">Gross</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => open(r.payment_reference)}>
                    <td className="ref font-semibold text-op-primary">{r.payment_reference}</td>
                    <td>
                      {r.channel} / {r.rail}
                    </td>
                    <td className="tabular-nums">{r.value_date}</td>
                    <td className="num">{pkr(r.gross_amount_minor)}</td>
                    <td>
                      <Status value={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {detail && (
        <div className="space-y-3">
          <button className="btn-secondary btn-xs" onClick={() => setDetail(null)}>
            ← Back to results
          </button>

          <section className="panel">
            <div className="panel-head flex items-center justify-between">
              <span className="ref text-[13px] font-bold normal-case tracking-normal">{detail.payment_reference}</span>
              <span className="flex items-center gap-2">
                <Status value={detail.status} />
                <button className="btn-secondary btn-xs" disabled={busy} onClick={requestRecall}>
                  {busy ? "Requesting…" : "Recall payment"}
                </button>
              </span>
            </div>
            <div className="p-3 grid grid-cols-6 gap-4">
              <Field label="Gross">{pkr(detail.gross_amount_minor)}</Field>
              <Field label="Unapplied">{pkr(detail.unapplied_amount_minor)}</Field>
              <Field label="Channel / rail">
                {detail.channel} / {detail.rail}
              </Field>
              <Field label="Value date">{detail.value_date}</Field>
              <Field label="Obligation discharged">{detail.obligation_discharge_date}</Field>
              <Field label="Finality">{detail.finality}</Field>
            </div>
            {detail.third_party_payer && (
              <div className="px-3 pb-3 text-op-accent">
                Received from <strong>{detail.third_party_payer.name}</strong> ({detail.third_party_payer.maskedId},{" "}
                {detail.third_party_payer.relationship}) on behalf of the bill's own payer. Any refund defaults to this
                account, not the taxpayer's.
              </div>
            )}
            {recall && (
              <div className="px-3 pb-3">
                <Notice tone={recall.outcome === "RETURNED" ? "good" : "warn"}>
                  Recall outcome: <strong>{recall.outcome.replace(/_/g, " ")}</strong>
                  {recall.camt029_reason && <span className="text-op-inkDim"> — {recall.camt029_reason}</span>}
                </Notice>
              </div>
            )}
          </section>

          <div className="grid grid-cols-2 gap-3 items-start">
            <section className="panel">
              <div className="panel-head">Allocations — what this money paid</div>
              {detail.allocations.length === 0 ? (
                <Empty>Not applied to any bill.</Empty>
              ) : (
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>PSID</th>
                      <th>Head</th>
                      <th className="num">Amount</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.allocations.map((a, i) => (
                      <tr key={i}>
                        <td className="ref">{a.psid}</td>
                        <td className="ref">{a.head_code}</td>
                        <td className="num">{pkr(a.amount_minor)}</td>
                        <td>
                          <Status value={a.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">Journal entries posted</div>
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Event</th>
                    <th>Account</th>
                    <th>Dr/Cr</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.journal_entries.map((j, i) => (
                    <tr key={i}>
                      <td className="ref">#{j.entry_no}</td>
                      <td className="text-[11px]">{j.event_type}</td>
                      <td className="ref">{j.account_code}</td>
                      <td>
                        <span className={`badge ${j.direction === "DR" ? "badge-neutral" : "badge-good"}`}>{j.direction}</span>
                      </td>
                      <td className="num">{pkr(j.amount_minor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <div className="grid grid-cols-2 gap-3 items-start">
            <section className="panel">
              <div className="panel-head">Receipt</div>
              <div className="p-3">
                {detail.receipt ? (
                  <span>
                    <span className="ref font-semibold">{detail.receipt.receipt_no}</span>{" "}
                    <Status value={detail.receipt.status} />
                  </span>
                ) : (
                  <span className="text-op-inkDim">No receipt issued.</span>
                )}
              </div>
            </section>
            <section className="panel">
              <div className="panel-head">Reconciliation</div>
              <div className="p-3">
                {detail.recon_breaks.length === 0 ? (
                  <span className="text-op-good">No break against this payment.</span>
                ) : (
                  detail.recon_breaks.map((b, i) => (
                    <div key={i}>
                      <span className="ref font-bold">{b.break_code}</span> {pkr(b.amount_minor)} <Status value={b.status} />
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          <section className="panel">
            <div className="panel-head">Application trace — how this money was applied, replayably</div>
            <pre className="p-3 text-[11px] font-mono overflow-x-auto max-h-72">
              {JSON.stringify(detail.application_trace, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
