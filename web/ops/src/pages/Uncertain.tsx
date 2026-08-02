import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Notice, PageHead } from "../ui.js";

interface Row {
  payment_reference: string;
  gross_amount_minor: number;
  channel: string;
  rail: string;
  received_at: string;
  uncertain_resolution_source: string | null;
}

/** §9.4's five escalating strategies, in the order the resolver tries them. */
const SOURCES = [
  { value: "RAIL_STATUS_ENQUIRY", label: "Rail status enquiry" },
  { value: "AGGREGATOR_ADVICE", label: "Aggregator advice" },
  { value: "INTRADAY_STATEMENT", label: "Intraday statement" },
  { value: "EOD_STATEMENT", label: "End-of-day statement" },
  { value: "HUMAN_INVESTIGATION", label: "Human investigation" },
];

export default function Uncertain(): JSX.Element {
  const [rows, setRows] = useState<Row[]>([]);
  const [source, setSource] = useState(SOURCES[0]!.value);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.get<Row[]>("/internal/payments/uncertain"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(ref: string, outcome: "FOUND_PAID" | "FOUND_NOT_PAID"): Promise<void> {
    setBusy(ref);
    setError(null);
    setDone(null);
    try {
      await api.post(`/internal/payments/${encodeURIComponent(ref)}/resolve-uncertain`, { outcome, source }, { idempotent: false });
      setDone(
        outcome === "FOUND_PAID"
          ? `${ref} confirmed on ${source.replace(/_/g, " ").toLowerCase()} — allocated exactly as if it had confirmed instantly.`
          : `${ref} confirmed as never received, and marked failed.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHead
        title="UNCERTAIN payments"
        right={
          <label className="flex items-center gap-2">
            <span className="metric-label">Evidence source</span>
            <select className="select w-56" value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        }
        note="A capture can time out with the money already gone. These are payments whose outcome genuinely could not be determined — never shown to the payer as a failure, and resolved here only on real evidence, from whichever of the five escalating sources actually answered."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <div className="panel">
        <div className="panel-head">Queue — {rows.length}</div>
        {rows.length === 0 ? (
          <Empty>Nothing uncertain. Every payment has a determined outcome.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Payment</th>
                <th>Channel / rail</th>
                <th>Received</th>
                <th className="num">Amount</th>
                <th style={{ width: "18rem" }}>Resolve on evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.payment_reference}>
                  <td className="ref font-semibold">{r.payment_reference}</td>
                  <td>
                    {r.channel} / {r.rail}
                  </td>
                  <td className="text-[11px] text-op-inkDim">{new Date(r.received_at).toLocaleString()}</td>
                  <td className="num">{pkr(r.gross_amount_minor)}</td>
                  <td>
                    <div className="flex gap-1">
                      <button className="btn btn-xs" disabled={busy !== null} onClick={() => resolve(r.payment_reference, "FOUND_PAID")}>
                        Found paid
                      </button>
                      <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => resolve(r.payment_reference, "FOUND_NOT_PAID")}>
                        Found not paid
                      </button>
                    </div>
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
