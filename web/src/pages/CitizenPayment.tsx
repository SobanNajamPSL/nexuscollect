import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatPKR } from "../lib/api.js";

const KEY_TYPES = ["PSID", "VEHICLE_REG", "CNIC", "NTN", "RF_REFERENCE", "CASE_NO", "APPLICATION_NO"];

interface Payable {
  psid: string;
  agency_code: string;
  agency_name: string;
  product_code: string;
  category: string;
  label: string;
  payable_amount_minor: number;
  status: string;
  due_date: string;
  discount_applied_minor: number;
  discount_expires_on: string | null;
  payer_name_masked: string | null;
}
interface Settled {
  psid: string;
  status: string;
  settled_on: string;
  receipt_no: string;
}
interface ResolveResponse {
  resolution_token: string | null;
  token_expires_at: string | null;
  payables: Payable[];
  settled: Settled[];
}

export default function CitizenPayment() {
  const navigate = useNavigate();
  const [keyType, setKeyType] = useState("VEHICLE_REG");
  const [keyValue, setKeyValue] = useState("LEA-17-1000");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [paying, setPaying] = useState(false);

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<ResolveResponse>("/v1/resolve", { key_type: keyType, key_value: keyValue, channel: "APP" }, { idempotent: false });
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePayAll() {
    if (!result?.resolution_token) return;
    setPaying(true);
    setError(null);
    try {
      const intent = await api.post<{ intent_reference: string; total_debit_minor: number }>("/v1/payment-intents", { resolution_token: result.resolution_token, channel: "APP" });
      const payment = await api.post<{ payment_reference: string; status: string }>("/v1/payments", {
        intent_reference: intent.intent_reference,
        channel: "APP",
        rail: "RAAST",
        gross_amount_minor: intent.total_debit_minor,
        value_date: "2026-07-30",
        obligation_discharge_date: "2026-07-30",
        capture_outcome: "CONFIRMED",
      });
      if (payment.status === "CONFIRMED") {
        navigate(`/receipt/${payment.payment_reference}`);
      } else {
        setError(`Payment is ${payment.status} — we're confirming your payment, this is not a failure.`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Pay a government bill</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Look up any bill by PSID, vehicle registration, CNIC, or reference number.</p>
      </div>

      <form onSubmit={handleResolve} className="card p-4 flex flex-col sm:flex-row gap-3">
        <select className="input sm:w-52" value={keyType} onChange={(e) => setKeyType(e.target.value)}>
          {KEY_TYPES.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <input className="input flex-1" value={keyValue} onChange={(e) => setKeyValue(e.target.value)} placeholder="e.g. LEA-17-1000" />
        <button className="btn" disabled={loading} type="submit">{loading ? "Looking up…" : "Find my bills"}</button>
      </form>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {result && (
        <div className="space-y-4">
          {result.payables.length === 0 && result.settled.length === 0 && (
            <div className="card p-4 text-gov-ink/70">No payables found for this reference.</div>
          )}

          {result.payables.length > 0 && (
            <div className="card divide-y divide-gov-border">
              <div className="p-4 font-semibold flex items-center justify-between">
                <span>{result.payables.length} outstanding payable{result.payables.length > 1 ? "s" : ""}</span>
                <button className="btn" disabled={paying} onClick={handlePayAll}>{paying ? "Processing…" : "Pay all"}</button>
              </div>
              {result.payables.map((p) => (
                <div key={p.psid} className="p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium">{p.label}</div>
                      <div className="text-xs text-gov-ink/60">{p.agency_name} · PSID {p.psid} · due {p.due_date}</div>
                      {p.payer_name_masked && <div className="text-xs text-gov-ink/60">Payer: {p.payer_name_masked}</div>}
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold">PKR {formatPKR(p.payable_amount_minor)}</div>
                      <span className={`badge ${p.status === "OVERDUE" ? "bg-red-100 text-red-700" : p.status === "EXPIRED" ? "bg-gray-200 text-gray-700" : "bg-amber-100 text-amber-800"}`}>{p.status}</span>
                    </div>
                  </div>
                  {p.discount_applied_minor > 0 && (
                    <div className="mt-2 text-xs bg-green-50 text-green-800 rounded px-2 py-1 inline-block">
                      Early-payment discount of PKR {formatPKR(p.discount_applied_minor)} live until {p.discount_expires_on}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {result.settled.length > 0 && (
            <div className="card divide-y divide-gov-border">
              <div className="p-4 font-semibold">Already settled</div>
              {result.settled.map((s) => (
                <div key={s.psid} className="p-4 flex justify-between items-center">
                  <div>
                    <div className="font-medium">PSID {s.psid}</div>
                    <div className="text-xs text-gov-ink/60">Settled {s.settled_on} · Receipt {s.receipt_no}</div>
                  </div>
                  <span className="badge bg-green-100 text-green-800">ALREADY SETTLED</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
