import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Agency { code: string; name: string; tier: string; settlement_model: string; sweep_schedule: string; status: string }
interface ProductRow { id: string; agency_code: string; code: string; category: string; status: string; overpay_treatment: string; allocation_waterfall: string }
interface ReferenceScheme { id: string; code: string; prefix: string; total_length: number; agency_code: string }
interface RevenueHead { id: string; code: string; name: string; agency_code: string }

const CATEGORIES = ["TAX", "DUTY", "FINE", "PENALTY", "FEE", "BILL", "STAMP", "DEPOSIT", "MISC"];
const WATERFALLS = ["PENALTY_FIRST", "PRINCIPAL_FIRST", "OLDEST_FIRST", "PRO_RATA", "EXPLICIT_ONLY"];
const OVERPAY = ["REJECT", "CREDIT_ON_ACCOUNT", "AUTO_REFUND", "ABSORB"];
const CHANNELS = ["APP", "QR", "RTP", "BILLER", "ATM", "IBANKING", "OTC_CASH", "CHEQUE", "CARD", "WALLET", "AGENT", "API"];
const INSTRUMENTS = ["CHEQUE", "PAY_ORDER", "DEMAND_DRAFT", "CASH"];

export default function AgencyConfig() {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [schemes, setSchemes] = useState<ReferenceScheme[]>([]);
  const [heads, setHeads] = useState<RevenueHead[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [makerUserId] = useState(() => crypto.randomUUID());
  const [checkerUserId] = useState(() => crypto.randomUUID());

  // Wizard state — mirrors the guided flow in the demo script (reference
  // scheme → amount rule → partial-payment policy → overpayment treatment →
  // channels → instruments → fee bearer → revenue head → waterfall →
  // service gating), collapsed into one form for this build.
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [referenceSchemeId, setReferenceSchemeId] = useState("");
  const [allowPartial, setAllowPartial] = useState(false);
  const [overpayTreatment, setOverpayTreatment] = useState(OVERPAY[0]!);
  const [channels, setChannels] = useState<string[]>(["APP", "IBANKING"]);
  const [instruments, setInstruments] = useState<string[]>(["CHEQUE"]);
  const [feeBearer, setFeeBearer] = useState<"PAYER" | "AGENCY" | "SPLIT">("PAYER");
  const [defaultRevenueHeadId, setDefaultRevenueHeadId] = useState("");
  const [waterfall, setWaterfall] = useState(WATERFALLS[0]!);
  const [serviceGating, setServiceGating] = useState<"NONE" | "BLOCKS_SERVICE" | "RELEASES_GOODS">("NONE");
  const [depositRefundable, setDepositRefundable] = useState(false);

  useEffect(() => {
    api.get<Agency[]>("/internal/agencies").then(setAgencies).catch((e) => setError(e.message));
  }, []);

  async function selectAgency(agencyCode: string) {
    setSelected(agencyCode);
    setShowWizard(false);
    setError(null);
    try {
      setProducts(await api.get<ProductRow[]>(`/internal/products?agency_code=${agencyCode}`));
      setSchemes(await api.get<ReferenceScheme[]>(`/internal/reference-schemes?agency_code=${agencyCode}`));
      setHeads(await api.get<RevenueHead[]>(`/internal/revenue-heads?agency_code=${agencyCode}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function createProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    try {
      await api.post(`/internal/agencies/${selected}/products`, {
        code, name, category, reference_scheme_id: referenceSchemeId, amount_rule: "ASSESSED",
        allow_partial: allowPartial, overpay_treatment: overpayTreatment, allocation_waterfall: waterfall,
        allowed_channels: channels, allowed_instruments: instruments, instrument_credit_policy: "ON_CLEARING",
        fee_bearer: feeBearer, default_revenue_head_id: defaultRevenueHeadId, service_gating: serviceGating,
        deposit_refundable: depositRefundable, effective_from: "2026-07-30", actor_id: makerUserId,
      });
      setShowWizard(false);
      setCode(""); setName("");
      await selectAgency(selected);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function approve(productId: string) {
    if (!selected) return;
    setError(null);
    try {
      await api.post(`/internal/products/${productId}/approve`, { checker_user_id: checkerUserId });
      await selectAgency(selected);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Agency &amp; product configuration</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Onboard a new collection product with no code change — maker-checker gated, live in every eligible channel once approved.</p>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      <div className="card divide-y divide-gov-border">
        {agencies.map((a) => (
          <button key={a.code} className={`w-full text-left p-3 hover:bg-gray-50 ${selected === a.code ? "bg-gray-50" : ""}`} onClick={() => selectAgency(a.code)}>
            <div className="flex items-center justify-between">
              <div><span className="font-medium">{a.code}</span> — {a.name}</div>
              <span className="badge bg-gray-100 text-gray-700 text-xs">{a.tier}</span>
            </div>
            <div className="text-xs text-gov-ink/60">{a.settlement_model} — sweep {a.sweep_schedule} — {a.status}</div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="card">
          <div className="p-3 font-semibold bg-gray-50 flex items-center justify-between">
            <span>{selected} products</span>
            <button className="btn-secondary text-xs" onClick={() => setShowWizard((s) => !s)}>{showWizard ? "Cancel" : "New product"}</button>
          </div>

          {showWizard && (
            <form onSubmit={createProduct} className="p-4 space-y-3 border-b border-gov-border">
              <div className="grid grid-cols-2 gap-3">
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Product code" required />
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" required />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                <select className="input" value={referenceSchemeId} onChange={(e) => setReferenceSchemeId(e.target.value)} required>
                  <option value="">Reference scheme…</option>
                  {schemes.map((s) => <option key={s.id} value={s.id}>{s.code} ({s.prefix}, {s.total_length}-digit)</option>)}
                </select>
                <select className="input" value={defaultRevenueHeadId} onChange={(e) => setDefaultRevenueHeadId(e.target.value)} required>
                  <option value="">Default revenue head…</option>
                  {heads.map((h) => <option key={h.id} value={h.id}>{h.code} — {h.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} /> Allow partial payment</label>
                <select className="input" value={overpayTreatment} onChange={(e) => setOverpayTreatment(e.target.value)}>{OVERPAY.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                <select className="input" value={waterfall} onChange={(e) => setWaterfall(e.target.value)}>{WATERFALLS.map((w) => <option key={w} value={w}>{w}</option>)}</select>
              </div>
              <div>
                <div className="text-xs text-gov-ink/60 mb-1">Eligible channels</div>
                <div className="flex flex-wrap gap-2">
                  {CHANNELS.map((c) => (
                    <label key={c} className="text-xs flex items-center gap-1 bg-gray-50 rounded px-2 py-1">
                      <input type="checkbox" checked={channels.includes(c)} onChange={() => toggle(channels, setChannels, c)} /> {c}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-gov-ink/60 mb-1">Accepted instruments</div>
                <div className="flex flex-wrap gap-2">
                  {INSTRUMENTS.map((i) => (
                    <label key={i} className="text-xs flex items-center gap-1 bg-gray-50 rounded px-2 py-1">
                      <input type="checkbox" checked={instruments.includes(i)} onChange={() => toggle(instruments, setInstruments, i)} /> {i}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <select className="input" value={feeBearer} onChange={(e) => setFeeBearer(e.target.value as never)}>
                  <option value="PAYER">Fee borne by payer</option><option value="AGENCY">Fee borne by agency</option><option value="SPLIT">Fee split</option>
                </select>
                <select className="input" value={serviceGating} onChange={(e) => setServiceGating(e.target.value as never)}>
                  <option value="NONE">No service gating</option><option value="BLOCKS_SERVICE">Blocks service until paid</option><option value="RELEASES_GOODS">Releases goods on payment</option>
                </select>
                <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={depositRefundable} onChange={(e) => setDepositRefundable(e.target.checked)} /> Refundable deposit (2040, not revenue)</label>
              </div>
              <button className="btn" type="submit">Submit for approval</button>
            </form>
          )}

          <table className="w-full text-sm">
            <thead><tr className="text-left text-gov-ink/60 border-b border-gov-border"><th className="p-3">Code</th><th className="p-3">Category</th><th className="p-3">Waterfall</th><th className="p-3">Overpay treatment</th><th className="p-3">Status</th><th className="p-3"></th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-gov-border last:border-0">
                  <td className="p-3">{p.code}</td><td className="p-3">{p.category}</td><td className="p-3">{p.allocation_waterfall}</td>
                  <td className="p-3">{p.overpay_treatment}</td><td className="p-3">{p.status}</td>
                  <td className="p-3">{p.status === "PENDING_APPROVAL" && <button className="btn-secondary text-xs" onClick={() => approve(p.id)}>Approve (as a different user)</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
