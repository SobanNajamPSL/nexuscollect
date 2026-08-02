import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Instrument {
  id: string;
  instrument_type: string;
  instrument_number: string | null;
  drawee_bank_name: string | null;
  drawer_name: string | null;
  amount_minor: number;
  status: string;
  lodged_on: string | null;
  returned_on: string | null;
  return_reason_code: string | null;
  agency_code: string;
}
interface Cascade {
  reversed_payment_ids: string[];
  unsettled_assessment_ids: string[];
  voided_receipt_ids: string[];
  dishonour_assessment_id: string | null;
}

const REASONS = ["INSUFFICIENT_FUNDS", "STOPPED_BY_DRAWER", "SIGNATURE_DIFFERS", "ACCOUNT_CLOSED", "STALE_DATED"];

/**
 * Clearing and returns only. Lodgement happens at a counter, so it lives in the
 * field portal — the bank's return notification arrives here, centrally, days
 * later, which is why the cascade plays out in the operator console.
 */
export default function Instruments(): JSX.Element {
  const [rows, setRows] = useState<Instrument[]>([]);
  const [reason, setReason] = useState(REASONS[0]!);
  const [cascade, setCascade] = useState<Cascade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await api.get<Instrument[]>("/internal/instruments")); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleReturn(id: string): Promise<void> {
    setBusy(id); setError(null); setCascade(null);
    try {
      setCascade(await api.post<Cascade>(`/internal/instruments/${id}/return`, { reason_code: reason }, { idempotent: false }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  return (
    <div>
      <PageHead
        title="Instrument clearing & returns"
        right={
          <label className="flex items-center gap-2">
            <span className="metric-label">Return reason</span>
            <select className="select w-56" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
            </select>
          </label>
        }
        note="A cheque can be accepted, provisionally credited, and only later discovered to be worthless. Returning one here unwinds every downstream effect at once — which is the hard part: reversing money correctly is considerably harder than accepting it."
      />

      {error && <Notice tone="bad">{error}</Notice>}

      {cascade && (
        <section className="panel mb-3 border-op-warn/50 bg-op-warn/[0.04]">
          <div className="panel-head text-op-warn">Dishonour cascade applied</div>
          <ul className="px-4 py-3 space-y-1 list-disc list-inside">
            <li>{cascade.reversed_payment_ids.length} payment(s) reversed</li>
            <li>
              {cascade.unsettled_assessment_ids.length} bill(s) un-settled — surcharge resumes from the{" "}
              <strong>original</strong> due date, so the time the bad cheque sat looking like good money is not a grace period
            </li>
            <li>{cascade.voided_receipt_ids.length} receipt(s) voided, never deleted — a voided receipt still exists and still shows its original detail</li>
            <li>Service gate re-closed on every affected bill</li>
            {cascade.dishonour_assessment_id && <li>A dishonour charge has been raised as a new bill against the drawer</li>}
          </ul>
        </section>
      )}

      <div className="panel">
        <div className="panel-head">Register — {rows.length}</div>
        {rows.length === 0 ? <Empty>No instruments lodged.</Empty> : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Instrument</th><th>Drawer / bank</th><th>Agency</th><th>Lodged</th>
                <th className="num">Amount</th><th>Status</th><th style={{ width: "9rem" }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>
                    <span className="font-semibold">{i.instrument_type.replace(/_/g, " ")}</span>{" "}
                    <span className="ref">{i.instrument_number ?? ""}</span>
                    {i.returned_on && <div className="text-[11px] text-op-bad">Returned {i.returned_on} — {i.return_reason_code?.replace(/_/g, " ")}</div>}
                  </td>
                  <td>
                    {i.drawer_name ?? "—"}
                    <div className="text-[11px] text-op-inkDim">{i.drawee_bank_name ?? "—"}</div>
                  </td>
                  <td>{i.agency_code}</td>
                  <td className="tabular-nums text-[11px]">{i.lodged_on ?? "—"}</td>
                  <td className="num">{pkr(i.amount_minor)}</td>
                  <td><Status value={i.status} /></td>
                  <td>
                    {i.status !== "RETURNED" && (
                      <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => handleReturn(i.id)}>
                        {busy === i.id ? "Returning…" : "Return (dishonour)"}
                      </button>
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
