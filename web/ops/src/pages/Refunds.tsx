import { useState } from "react";
import { api } from "@shared/api.js";
import { toMinor } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { Notice, PageHead, Status } from "../ui.js";

const REASONS = ["OVERPAYMENT", "DUPLICATE", "CANCELLED_SERVICE", "ASSESSMENT_AMENDED", "ERRONEOUS_PAYMENT", "DEPOSIT_RELEASE", "COURT_ORDER"];

interface Created { refund_id: string; refund_reference: string; status: string }

/**
 * Maker-checker on refunds, using real users from the roster. The maker is
 * whoever is acting; the checker must be a different person holding the approver
 * role — the database refuses a self-approval, so the screen resolves a genuine
 * second user rather than minting a throwaway id.
 */
export default function Refunds(): JSX.Element {
  const { current } = usePersona();
  const [paymentReference, setPaymentReference] = useState("");
  const [amountPkr, setAmountPkr] = useState("");
  const [reason, setReason] = useState(REASONS[0]!);
  const [mode, setMode] = useState<"SURPLUS_ONLY" | "FULL_REVERSAL">("SURPLUS_ONLY");
  const [funding, setFunding] = useState<"PLATFORM_HELD" | "AGENCY_FUNDED">("PLATFORM_HELD");
  const [refund, setRefund] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function approverOtherThan(makerId: string): Promise<{ id: string; name: string } | null> {
    const users = await api.get<{ id: string; name: string; roles: string[] }[]>("/internal/users");
    return users.find((u) => u.roles.includes("OPS_REFUND_APPROVER") && u.id !== makerId) ?? null;
  }

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!current) return;
    setBusy(true); setError(null); setDone(null);
    try {
      setRefund(await api.post<Created>("/internal/refunds", {
        payment_reference: paymentReference,
        amount_minor: toMinor(amountPkr),
        reason_code: reason,
        mode,
        funding_source: funding,
        actor_id: current.id,
      }));
      setDone(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function approve(): Promise<void> {
    if (!refund || !current) return;
    setBusy(true); setError(null);
    try {
      const checker = await approverOtherThan(current.id);
      if (!checker) {
        setError("No refund approver other than the acting user is available — a refund cannot be approved by the person who raised it.");
        return;
      }
      await api.post(`/internal/refunds/${refund.refund_id}/approve`, { checker_user_id: checker.id, maker_user_id: current.id });
      setRefund({ ...refund, status: "APPROVED" });
      setDone(`Approved by ${checker.name.replace(/\s*\(.*\)$/, "")} — a different person from whoever raised it.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function pay(): Promise<void> {
    if (!refund) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/internal/refunds/${refund.refund_id}/pay`, {});
      setRefund({ ...refund, status: "PAID" });
      setDone("Paid to the original debit account.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHead
        title="Refunds"
        note="Two genuinely different paths: a surplus-only refund never touches an allocation, while a full reversal unwinds one. The beneficiary always defaults to the account the money came from — redirecting it requires an approved override, because that is the main refund-fraud vector."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <form onSubmit={create} className="panel mb-3">
        <div className="panel-head">Raise a refund</div>
        <div className="p-3 grid grid-cols-4 gap-3">
          <div className="col-span-2">
            <label className="label" htmlFor="pref">Payment reference</label>
            <input id="pref" className="input" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} required placeholder="P2600001" />
          </div>
          <div>
            <label className="label" htmlFor="amt">Amount (PKR)</label>
            <input id="amt" className="input text-right tabular-nums" type="number" step="0.01" value={amountPkr} onChange={(e) => setAmountPkr(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="rsn">Reason</label>
            <select id="rsn" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="mode">Mode</label>
            <select id="mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as never)}>
              <option value="SURPLUS_ONLY">Surplus only — allocations untouched</option>
              <option value="FULL_REVERSAL">Full reversal — unwind the allocation</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="fund">Funding source</label>
            <select id="fund" className="select" value={funding} onChange={(e) => setFunding(e.target.value as never)}>
              <option value="PLATFORM_HELD">Platform-held funds</option>
              <option value="AGENCY_FUNDED">Agency-funded — already swept, so the agency decides</option>
            </select>
          </div>
          <div className="col-span-4">
            <button className="btn" type="submit" disabled={busy}>{busy ? "Working…" : "Raise refund"}</button>
          </div>
        </div>
      </form>

      {refund && (
        <div className="panel">
          <div className="panel-head flex items-center justify-between">
            <span className="ref normal-case tracking-normal text-[13px] font-bold">{refund.refund_reference}</span>
            <Status value={refund.status} />
          </div>
          <div className="p-3 flex items-center gap-2">
            <button className="btn-secondary btn-xs" disabled={busy || refund.status !== "PENDING_APPROVAL"} onClick={approve}>
              Approve as a different user
            </button>
            <button className="btn btn-xs" disabled={busy || refund.status !== "APPROVED"} onClick={pay}>
              Pay
            </button>
            <span className="text-[11px] text-op-inkDim">
              A refund can only be paid after approval by someone other than whoever raised it.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
