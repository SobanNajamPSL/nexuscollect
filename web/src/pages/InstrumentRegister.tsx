import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface InstrumentDto {
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
  dishonour_charge_assessment_id: string | null;
  agency_code: string;
}
interface CascadeResult {
  reversed_payment_ids: string[];
  unsettled_assessment_ids: string[];
  voided_receipt_ids: string[];
  dishonour_assessment_id: string | null;
}

export default function InstrumentRegister() {
  const [instruments, setInstruments] = useState<InstrumentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState<string | null>(null);
  const [cascade, setCascade] = useState<CascadeResult | null>(null);

  async function load() {
    try {
      setInstruments(await api.get<InstrumentDto[]>("/internal/instruments"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleReturn(id: string) {
    setReturning(id);
    setError(null);
    setCascade(null);
    try {
      const result = await api.post<CascadeResult>(`/internal/instruments/${id}/return`, { reason_code: "INSUFFICIENT_FUNDS" }, { idempotent: false });
      setCascade(result);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReturning(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Instrument register</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Cheques, pay orders and demand drafts — lodge, link, clear, return.</p>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {cascade && (
        <div className="card p-4 border-amber-300 bg-amber-50">
          <div className="font-semibold text-amber-900">Dishonour cascade applied</div>
          <ul className="text-sm text-amber-800 mt-2 space-y-1 list-disc list-inside">
            <li>{cascade.reversed_payment_ids.length} payment(s) reversed</li>
            <li>{cascade.unsettled_assessment_ids.length} assessment(s) un-settled — surcharge resumes from the original due date</li>
            <li>{cascade.voided_receipt_ids.length} receipt(s) voided (not deleted)</li>
            <li>Service gate re-closed on all affected assessments</li>
            {cascade.dishonour_assessment_id && <li>A new dishonour charge assessment has been raised</li>}
          </ul>
        </div>
      )}

      <div className="card divide-y divide-gov-border">
        {instruments.map((inst) => (
          <div key={inst.id} className="p-4 flex justify-between items-center gap-4">
            <div>
              <div className="font-medium">{inst.instrument_type} {inst.instrument_number ?? ""}</div>
              <div className="text-xs text-gov-ink/60">{inst.agency_code} · {inst.drawee_bank_name ?? "—"} · Drawer: {inst.drawer_name ?? "—"}</div>
              {inst.returned_on && <div className="text-xs text-red-700 mt-0.5">Returned {inst.returned_on} — {inst.return_reason_code}</div>}
            </div>
            <div className="text-right shrink-0">
              <div className="font-semibold">PKR {formatPKR(inst.amount_minor)}</div>
              <span className={`badge ${inst.status === "RETURNED" ? "bg-red-100 text-red-800" : inst.status === "CLEARED" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>{inst.status}</span>
            </div>
            {inst.status !== "RETURNED" && (
              <button className="btn-secondary text-xs" disabled={returning === inst.id} onClick={() => handleReturn(inst.id)}>
                {returning === inst.id ? "Returning…" : "Return (dishonour)"}
              </button>
            )}
          </div>
        ))}
        {instruments.length === 0 && <div className="p-4 text-gov-ink/60">No instruments lodged yet.</div>}
      </div>
    </div>
  );
}
