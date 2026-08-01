import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

const REASON_CODES = ["OVERPAYMENT", "DUPLICATE", "CANCELLED_SERVICE", "ASSESSMENT_AMENDED", "ERRONEOUS_PAYMENT", "DEPOSIT_RELEASE", "COURT_ORDER"];

interface CreatedRefund { refund_id: string; refund_reference: string; status: string }

export default function Refunds() {
  const [paymentReference, setPaymentReference] = useState("");
  const [amountPkr, setAmountPkr] = useState("");
  const [reasonCode, setReasonCode] = useState(REASON_CODES[0]!);
  const [mode, setMode] = useState<"SURPLUS_ONLY" | "FULL_REVERSAL">("SURPLUS_ONLY");
  const [fundingSource, setFundingSource] = useState<"PLATFORM_HELD" | "AGENCY_FUNDED">("PLATFORM_HELD");
  // `approval.maker_user_id`/`checker_user_id` are real UUID foreign-key
  // columns (not free-text labels) — this demo mints two distinct, stable
  // synthetic user ids client-side so maker-checker (enforced by the
  // database, never the same user twice) has real, valid ids to check.
  const [makerUserId] = useState(() => crypto.randomUUID());
  const [checkerUserId] = useState(() => crypto.randomUUID());
  const [refund, setRefund] = useState<CreatedRefund | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<CreatedRefund>("/internal/refunds", {
        payment_reference: paymentReference,
        amount_minor: Math.round(Number(amountPkr) * 100),
        reason_code: reasonCode,
        mode,
        funding_source: fundingSource,
        actor_id: makerUserId,
      });
      setRefund(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!refund) return;
    setBusy(true);
    setError(null);
    try {
      // Maker-checker: the checker MUST be a different user from the maker —
      // enforced by the database, not just this form.
      await api.post(`/internal/refunds/${refund.refund_id}/approve`, { checker_user_id: checkerUserId, maker_user_id: makerUserId });
      setRefund({ ...refund, status: "APPROVED" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!refund) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/internal/refunds/${refund.refund_id}/pay`, {});
      setRefund({ ...refund, status: "PAID" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Refunds</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Create, approve (as a different user), and pay a refund. Beneficiary always defaults to the original debit account.</p>
      </div>

      <form onSubmit={create} className="card p-4 space-y-3">
        <input className="input w-full" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="Payment reference (e.g. PM...)" required />
        <div className="grid grid-cols-2 gap-3">
          <input className="input" type="number" step="0.01" value={amountPkr} onChange={(e) => setAmountPkr(e.target.value)} placeholder="Amount (PKR)" required />
          <select className="input" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {REASON_CODES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as never)}>
            <option value="SURPLUS_ONLY">Surplus only (allocations untouched)</option>
            <option value="FULL_REVERSAL">Full reversal (un-settles the bill)</option>
          </select>
          <select className="input" value={fundingSource} onChange={(e) => setFundingSource(e.target.value as never)}>
            <option value="PLATFORM_HELD">Platform-held funds</option>
            <option value="AGENCY_FUNDED">Agency-funded (already swept)</option>
          </select>
        </div>
        <button className="btn" disabled={busy} type="submit">Create refund</button>
      </form>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {refund && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">{refund.refund_reference}</div>
            <span className="badge bg-gray-100 text-gray-700">{refund.status}</span>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary text-sm" disabled={busy || refund.status !== "PENDING_APPROVAL"} onClick={approve}>Approve (as a different user)</button>
            <button className="btn text-sm" disabled={busy || refund.status !== "APPROVED"} onClick={pay}>Pay</button>
          </div>
          <p className="text-xs text-gov-ink/60">A refund can only be paid after approval by a user other than the one who created it — this is enforced by the database, not just this screen.</p>
          <p className="text-xs text-gov-ink/40">Maker: {makerUserId.slice(0, 8)}… · Checker: {checkerUserId.slice(0, 8)}…</p>
        </div>
      )}

      <div className="text-xs text-gov-ink/50">Amounts entered here are PKR — converted to minor units (paisa) before being sent, matching this platform's own money rule.</div>
    </div>
  );
}
