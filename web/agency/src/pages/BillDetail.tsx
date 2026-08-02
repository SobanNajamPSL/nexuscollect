import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Assessment360 {
  psid: string;
  current_version: number;
  status: string;
  versions: {
    version: number;
    status: string;
    assessed_amount_minor: number;
    payable_amount_minor: number;
    allocated_amount_minor: number;
    balance_minor: number;
  }[];
  line_items: { head_code: string; line_type: string; amount_minor: number; allocated_minor: number }[];
  payment_history: { payment_reference: string; amount_minor: number; status: string; payment_status: string; applied_at: string }[];
  notifications: { event_type: string; channel: string; status: string; sent_at: string }[];
}

const AMEND_REASONS = ["APPEAL_ALLOWED", "RECTIFICATION_ORDER", "CLERICAL_ERROR", "REASSESSMENT", "WAIVER_GRANTED", "DISCOUNT_APPLIED"];
const CANCEL_REASONS = ["ISSUED_IN_ERROR", "DUPLICATE", "WITHDRAWN", "SUPERSEDED", "COURT_ORDER"];

export default function BillDetail(): JSX.Element {
  const { psid = "" } = useParams();
  const [data, setData] = useState<Assessment360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<"amend" | "cancel" | null>(null);

  const [amendReason, setAmendReason] = useState(AMEND_REASONS[0]!);
  const [amendDueDate, setAmendDueDate] = useState("");
  const [amendDescription, setAmendDescription] = useState("");
  const [narrative, setNarrative] = useState("");
  const [cancelReason, setCancelReason] = useState(CANCEL_REASONS[0]!);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<Assessment360>(`/internal/assessments/${encodeURIComponent(psid)}/360`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [psid]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentVersion = data?.versions.find((v) => v.version === data.current_version);
  const allocated = currentVersion?.allocated_amount_minor ?? 0;

  async function amend(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!data) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.patch(`/v1/agency/assessments/${encodeURIComponent(psid)}`, {
        expected_version: data.current_version,
        reason_code: amendReason,
        ...(amendDueDate ? { due_date: amendDueDate } : {}),
        ...(amendDescription ? { description: amendDescription } : {}),
        ...(narrative ? { narrative } : {}),
      });
      setDone(`Amended. A new version was written under the same PSID; version ${data.current_version} is retained as AMENDED.`);
      setAction(null);
      setAmendDueDate("");
      setAmendDescription("");
      setNarrative("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.post(`/v1/agency/assessments/${encodeURIComponent(psid)}/cancel`, {
        reason_code: cancelReason,
        ...(narrative ? { narrative } : {}),
      });
      setDone("Cancelled.");
      setAction(null);
      setNarrative("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <div className="text-ag-inkDim text-sm">Loading…</div>;

  return (
    <div className="space-y-5">
      <PageHead
        title={psid}
        right={
          <div className="flex items-center gap-3">
            <Status value={data.status} />
            <span className="text-xs text-ag-inkDim">version {data.current_version}</span>
          </div>
        }
      />

      <Link className="text-[13px] text-ag-primary hover:underline" to="/assessments">
        ← All bills
      </Link>

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <section className="sheet">
        <div className="sheet-head">Version history</div>
        <table className="statement">
          <thead>
            <tr>
              <th style={{ width: "4rem" }}>Version</th>
              <th>Status</th>
              <th className="num">Assessed</th>
              <th className="num">Payable</th>
              <th className="num">Paid</th>
              <th className="num">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.version} className={v.version === data.current_version ? "bg-ag-panelAlt" : ""}>
                <td className="tabular-nums">{v.version}</td>
                <td>
                  <Status value={v.status} />
                </td>
                <td className="num">{pkr(v.assessed_amount_minor)}</td>
                <td className="num">{pkr(v.payable_amount_minor)}</td>
                <td className="num">{pkr(v.allocated_amount_minor)}</td>
                <td className="num">{pkr(v.balance_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.versions.length > 1 && (
          <div className="px-4 py-2 border-t border-ag-rule text-[11px] text-ag-inkDim">
            An amendment never edits a bill in place — it writes a new version under the same PSID and marks the previous
            one AMENDED, so what the payer was originally told remains on the record.
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-5 items-start">
        <section className="sheet">
          <div className="sheet-head">Line items — head-wise</div>
          <table className="statement">
            <thead>
              <tr>
                <th>Head</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th className="num">Paid</th>
              </tr>
            </thead>
            <tbody>
              {data.line_items.map((l, i) => (
                <tr key={`${l.head_code}-${i}`}>
                  <td className="font-mono text-[13px]">{l.head_code}</td>
                  <td className="text-[12px]">{l.line_type}</td>
                  <td className="num">{pkr(l.amount_minor)}</td>
                  <td className="num">{pkr(l.allocated_minor)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td className="num">{pkr(data.line_items.reduce((s, l) => s + l.amount_minor, 0))}</td>
                <td className="num">{pkr(data.line_items.reduce((s, l) => s + l.allocated_minor, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        <section className="sheet">
          <div className="sheet-head">Payments received</div>
          {data.payment_history.length === 0 ? (
            <Empty>Nothing received against this bill yet.</Empty>
          ) : (
            <table className="statement">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Allocation</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.payment_history.map((p, i) => (
                  <tr key={`${p.payment_reference}-${i}`}>
                    <td className="font-mono text-[13px]">{p.payment_reference}</td>
                    <td>
                      <Status value={p.status} />
                    </td>
                    <td className="num">{pkr(p.amount_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Amend / cancel. Both are real state transitions through the same
          guarded path the API enforces, not local edits. */}
      <section className="sheet">
        <div className="sheet-head">Adjust this bill</div>
        <div className="p-4 space-y-4">
          {action === null && (
            <div className="flex items-center gap-3">
              <button className="btn-secondary btn-sm" onClick={() => setAction("amend")}>
                Amend
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setAction("cancel")} disabled={allocated > 0}>
                Cancel
              </button>
              {allocated > 0 && (
                <span className="text-[12px] text-ag-inkDim">
                  A bill with money applied to it cannot be cancelled — {pkr(allocated)} has been received, so the
                  correction is a refund or an amendment, not a cancellation.
                </span>
              )}
            </div>
          )}

          {action === "amend" && (
            <form onSubmit={amend} className="space-y-3 max-w-2xl">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="amend-reason">
                    Reason
                  </label>
                  <select id="amend-reason" className="select" value={amendReason} onChange={(e) => setAmendReason(e.target.value)}>
                    {AMEND_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="amend-due">
                    New due date <span className="font-normal normal-case">(optional)</span>
                  </label>
                  <input id="amend-due" className="input" type="date" value={amendDueDate} onChange={(e) => setAmendDueDate(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="amend-desc">
                  New description <span className="font-normal normal-case">(optional)</span>
                </label>
                <input id="amend-desc" className="input" value={amendDescription} onChange={(e) => setAmendDescription(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="narrative">
                  Narrative
                </label>
                <input id="narrative" className="input" value={narrative} onChange={(e) => setNarrative(e.target.value)} />
              </div>
              <p className="text-[12px] text-ag-inkDim">
                Amending against version {data.current_version}. If someone else amends this bill first, the request is
                rejected rather than silently overwriting their change.
              </p>
              <div className="flex gap-2">
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Amending…" : "Amend bill"}
                </button>
                <button className="btn-secondary" type="button" onClick={() => setAction(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {action === "cancel" && (
            <form onSubmit={cancel} className="space-y-3 max-w-2xl">
              <div>
                <label className="label" htmlFor="cancel-reason">
                  Reason
                </label>
                <select id="cancel-reason" className="select" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                  {CANCEL_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="cancel-narrative">
                  Narrative
                </label>
                <input id="cancel-narrative" className="input" value={narrative} onChange={(e) => setNarrative(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Cancelling…" : "Cancel bill"}
                </button>
                <button className="btn-secondary" type="button" onClick={() => setAction(null)}>
                  Keep bill
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
