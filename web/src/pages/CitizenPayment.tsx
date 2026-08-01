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
  const [cardWalletPsid, setCardWalletPsid] = useState<string | null>(null);
  const [cardWalletResult, setCardWalletResult] = useState<string | null>(null);

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

  // No real card number is ever collected here — there is no PAN field
  // anywhere in this form. A "gateway token" is what a hosted card field
  // would hand back in production; this demo generates a synthetic one
  // client-side purely to exercise the same capture path, and the result
  // shown below is exactly what the platform actually stores (token +
  // BIN6 + last4 — never a PAN).
  async function handleCardOrWallet(p: Payable, method: "card" | "wallet") {
    setError(null);
    setCardWalletResult(null);
    try {
      if (method === "card") {
        const res = await api.post<{ payment_id: string; status: string }>("/internal/payments/card", {
          psid: p.psid,
          amount_minor: p.payable_amount_minor,
          value_date: "2026-07-30",
          gateway_token: `tok_${crypto.randomUUID().slice(0, 12)}`,
          bin6: "435671",
          last4: "4242",
          scheme: "PAYPAK",
        });
        setCardWalletResult(`Card payment ${res.status} (${res.payment_id}) — stored token + BIN 435671 + last4 4242. No card number ever reached the platform.`);
      } else {
        const res = await api.post<{ payment_id: string; status: string }>("/internal/payments/wallet", {
          psid: p.psid,
          amount_minor: p.payable_amount_minor,
          value_date: "2026-07-30",
          wallet_provider: "EASYPAISA",
          wallet_msisdn_masked: "03**-***1234",
        });
        setCardWalletResult(`Wallet payment ${res.status} (${res.payment_id}) via EasyPaisa, masked MSISDN 03**-***1234.`);
      }
      setCardWalletPsid(null);
    } catch (err) {
      setError((err as Error).message);
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
      {cardWalletResult && <div className="card p-4 bg-green-50 border-green-300 text-green-800 text-sm">{cardWalletResult}</div>}

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
                  <div className="mt-2">
                    <button className="text-xs text-gov-primary underline" onClick={() => setCardWalletPsid(cardWalletPsid === p.psid ? null : p.psid)}>Pay just this bill by card or wallet</button>
                    {cardWalletPsid === p.psid && (
                      <div className="mt-2 flex gap-2">
                        <button className="btn-secondary text-xs" onClick={() => handleCardOrWallet(p, "card")}>Pay by card</button>
                        <button className="btn-secondary text-xs" onClick={() => handleCardOrWallet(p, "wallet")}>Pay by wallet</button>
                        <a className="btn-secondary text-xs" href={`/v1/challan/${p.psid}`} target="_blank" rel="noreferrer">Print challan</a>
                      </div>
                    )}
                  </div>
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
