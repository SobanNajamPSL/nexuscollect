import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Product {
  id: string;
  code: string;
  category: string;
  status: string;
  overpay_treatment: string;
  allocation_waterfall: string;
}
interface Scheme {
  id: string;
  code: string;
  prefix: string | null;
  total_length: number;
}
interface Head {
  id: string;
  code: string;
  name: string;
}

const CATEGORIES = ["TAX", "DUTY", "FINE", "PENALTY", "FEE", "BILL", "STAMP", "DEPOSIT", "MISC"];
const WATERFALLS = ["PENALTY_FIRST", "PRINCIPAL_FIRST", "OLDEST_FIRST", "PRO_RATA", "EXPLICIT_ONLY"];
const OVERPAY = ["REJECT", "CREDIT_ON_ACCOUNT", "AUTO_REFUND", "ABSORB"];
const CHANNELS = ["APP", "QR", "RTP", "BILLER", "ATM", "IBANKING", "OTC_CASH", "CHEQUE", "CARD", "WALLET", "AGENT", "API"];
const INSTRUMENTS = ["CHEQUE", "PAY_ORDER", "DEMAND_DRAFT", "CASH"];

/**
 * §3.2 gives the agency admin the checker role for its own configuration, so the
 * maker and checker ids here are two distinct values. `approval.maker_user_id` /
 * `checker_user_id` are real UUID foreign keys, and the database itself refuses
 * a self-approval — the acting user proposes, and a second real user approves.
 */
export default function Products(): JSX.Element {
  const { current } = usePersona();
  const agency = current?.agency_code;
  const clock = useDemoClock();
  const today = businessDate(clock);

  const [products, setProducts] = useState<Product[]>([]);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [heads, setHeads] = useState<Head[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string; agency_code: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [schemeId, setSchemeId] = useState("");
  const [headId, setHeadId] = useState("");
  const [allowPartial, setAllowPartial] = useState(false);
  const [overpay, setOverpay] = useState(OVERPAY[0]!);
  const [waterfall, setWaterfall] = useState(WATERFALLS[0]!);
  const [channels, setChannels] = useState<string[]>(["APP", "IBANKING"]);
  const [instruments, setInstruments] = useState<string[]>(["CASH"]);
  const [feeBearer, setFeeBearer] = useState<"PAYER" | "AGENCY" | "SPLIT">("PAYER");
  const [gating, setGating] = useState<"NONE" | "BLOCKS_SERVICE" | "RELEASES_GOODS">("NONE");
  const [depositRefundable, setDepositRefundable] = useState(false);

  const load = useCallback(async () => {
    if (!agency) return;
    setError(null);
    try {
      const [p, s, h, u] = await Promise.all([
        api.get<Product[]>(`/internal/products?agency_code=${agency}`),
        api.get<Scheme[]>(`/internal/reference-schemes?agency_code=${agency}`),
        api.get<Head[]>(`/internal/revenue-heads?agency_code=${agency}`),
        api.get<{ id: string; name: string; agency_code: string | null; roles: string[] }[]>("/internal/users"),
      ]);
      setProducts(p);
      setSchemes(s);
      setHeads(h);
      // Eligible checkers: an administrator of *this* agency. Cross-tenant
      // approval would defeat the point of tenant scoping.
      setUsers(u.filter((x) => x.roles.includes("AGENCY_ADMIN") && x.agency_code === agency));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agency]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(list: string[], set: (v: string[]) => void, value: string): void {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!agency || !today || !current) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.post(`/internal/agencies/${agency}/products`, {
        code,
        name,
        category,
        reference_scheme_id: schemeId,
        amount_rule: "ASSESSED",
        allow_partial: allowPartial,
        overpay_treatment: overpay,
        allocation_waterfall: waterfall,
        allowed_channels: channels,
        allowed_instruments: instruments,
        instrument_credit_policy: "ON_CLEARING",
        fee_bearer: feeBearer,
        default_revenue_head_id: headId,
        service_gating: gating,
        deposit_refundable: depositRefundable,
        effective_from: today,
        actor_id: current.id,
      });
      setDone(`${code} submitted for approval. It cannot collect a single rupee until a second user approves it.`);
      setShowForm(false);
      setCode("");
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(product: Product): Promise<void> {
    // The checker must be a *different* administrator from whoever proposed it.
    // The database enforces this, so offering the acting user as their own
    // checker would just produce an error — say why instead.
    const checker = users.find((u) => u.id !== current?.id);
    if (!checker) {
      setError(
        "No second administrator is available for this agency, and an administrator cannot approve their own proposal. Switch to another agency administrator to approve it.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.post(
        `/internal/products/${product.id}/approve`,
        { checker_user_id: checker.id },
        { headers: { "x-user-id": checker.id } },
      );
      setDone(`${product.code} approved by ${checker.name} and is now live in every eligible channel.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHead
        title="Products"
        right={
          <button className="btn-secondary btn-sm" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "New product"}
          </button>
        }
        note="A collection product is a kind of bill this agency issues, and everything about how it behaves — reference format, what happens on overpayment, which of the twelve channels may pay it, how a partial payment is applied across heads — is configuration, not code. Onboarding a new one requires no deployment."
      />

      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {done && (
        <div className="mb-4">
          <Notice tone="good">{done}</Notice>
        </div>
      )}

      {showForm && (
        <form onSubmit={create} className="sheet mb-6">
          <div className="sheet-head">New product</div>
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="label" htmlFor="p-code">
                  Product code
                </label>
                <input id="p-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} required placeholder="ETPB-NEW-FEE" />
              </div>
              <div>
                <label className="label" htmlFor="p-name">
                  Name
                </label>
                <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <label className="label" htmlFor="p-cat">
                  Category
                </label>
                <select id="p-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="p-scheme">
                  Reference scheme
                </label>
                <select id="p-scheme" className="select" value={schemeId} onChange={(e) => setSchemeId(e.target.value)} required>
                  <option value="">Select…</option>
                  {schemes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} ({s.total_length} digits{s.prefix ? `, prefix ${s.prefix}` : ""})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="p-head">
                  Default revenue head
                </label>
                <select id="p-head" className="select" value={headId} onChange={(e) => setHeadId(e.target.value)} required>
                  <option value="">Select…</option>
                  {heads.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.code} — {h.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="p-waterfall">
                  Allocation waterfall
                </label>
                <select id="p-waterfall" className="select" value={waterfall} onChange={(e) => setWaterfall(e.target.value)}>
                  {WATERFALLS.map((w) => (
                    <option key={w}>{w}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="p-overpay">
                  On overpayment
                </label>
                <select id="p-overpay" className="select" value={overpay} onChange={(e) => setOverpay(e.target.value)}>
                  {OVERPAY.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="p-fee">
                  Fee borne by
                </label>
                <select id="p-fee" className="select" value={feeBearer} onChange={(e) => setFeeBearer(e.target.value as never)}>
                  <option value="PAYER">Payer</option>
                  <option value="AGENCY">Agency</option>
                  <option value="SPLIT">Split</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="p-gating">
                  Service gating
                </label>
                <select id="p-gating" className="select" value={gating} onChange={(e) => setGating(e.target.value as never)}>
                  <option value="NONE">None</option>
                  <option value="BLOCKS_SERVICE">Blocks a service until paid</option>
                  <option value="RELEASES_GOODS">Releases goods on payment</option>
                </select>
              </div>
            </div>

            <div>
              <div className="label">Eligible channels</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {CHANNELS.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={channels.includes(c)} onChange={() => toggle(channels, setChannels, c)} />
                    {c}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="label">Accepted instruments</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {INSTRUMENTS.map((i) => (
                  <label key={i} className="flex items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={instruments.includes(i)} onChange={() => toggle(instruments, setInstruments, i)} />
                    {i.replace(/_/g, " ")}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
                Allow partial payment — a payer may settle less than the full amount, applied down the waterfall above
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={depositRefundable} onChange={(e) => setDepositRefundable(e.target.checked)} />
                Refundable deposit — money held on the depositor's behalf, credited to a liability account rather than revenue
              </label>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Submitting…" : "Submit for approval"}
              </button>
              <span className="text-[12px] text-ag-inkDim">
                Proposed by {current?.name.replace(/\s*\(.*\)$/, "")}; a different administrator must approve it.
              </span>
            </div>
          </div>
        </form>
      )}

      <div className="sheet overflow-x-auto">
        <table className="statement">
          <thead>
            <tr>
              <th>Code</th>
              <th>Category</th>
              <th>Waterfall</th>
              <th>On overpayment</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td className="font-semibold">{p.code}</td>
                <td className="text-[12px]">{p.category}</td>
                <td className="text-[12px]">{p.allocation_waterfall}</td>
                <td className="text-[12px]">{p.overpay_treatment.replace(/_/g, " ")}</td>
                <td>
                  <Status value={p.status} />
                </td>
                <td>
                  {p.status === "PENDING_APPROVAL" && (
                    <button className="btn-secondary btn-sm" disabled={busy} onClick={() => approve(p)}>
                      Approve as a second user
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <Empty>No products configured for this agency.</Empty>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
