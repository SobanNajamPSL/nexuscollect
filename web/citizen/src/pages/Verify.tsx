import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@shared/api.js";

/**
 * Public receipt verification.
 *
 * No login, no institution header, no payer detail — the whole point is that a
 * landlord, an employer, a court clerk or a customs agent can confirm a receipt
 * is genuine without being given access to anything else. So this page returns
 * the least it can: is this receipt real, and is it *still* valid.
 *
 * "Still" is the part that matters. A receipt is never deleted, but it can be
 * voided — a cheque that bounces takes its receipts down with it (§8.8), and a
 * refund marks them too. A verifier holding a printed receipt from three weeks
 * ago needs to learn that here, which is exactly why status is the headline and
 * not a footnote.
 *
 * Reached by typing a receipt number, or directly by scanning the QR code on the
 * receipt itself — hence the query parameter.
 */

interface VerifyResponse {
  receipt_no: string;
  agency_name: string;
  business_date: string;
  status: string;
  issued_at: string;
}

const STATUS: Record<string, { label: string; tone: string; note: string }> = {
  VALID: {
    label: "Valid",
    tone: "bg-emerald-50 border-emerald-200 text-emerald-900",
    note: "This receipt is genuine and has not been voided or refunded.",
  },
  VOIDED: {
    label: "Voided",
    tone: "bg-red-50 border-red-200 text-red-800",
    note: "This receipt was issued but has since been voided — most commonly because the instrument it was paid with was returned unpaid. The obligation it covered is outstanding again.",
  },
  REFUNDED: {
    label: "Refunded",
    tone: "bg-amber-50 border-amber-200 text-amber-900",
    note: "This receipt is genuine, but the payment behind it has since been refunded.",
  },
};

export default function Verify(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const fromQr = params.get("receipt") ?? "";

  const [entry, setEntry] = useState(fromQr);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup(receiptNo: string): Promise<void> {
    const trimmed = receiptNo.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setNotFound(false);
    setResult(null);
    try {
      setResult(await api.get<VerifyResponse>(`/v1/verify/${encodeURIComponent(trimmed)}`));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) setNotFound(true);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Arriving from a scanned QR code should just show the answer.
  useEffect(() => {
    if (fromQr) void lookup(fromQr);
  }, [fromQr]);

  const state = result ? (STATUS[result.status] ?? { label: result.status, tone: "bg-cz-bg border-cz-rule text-cz-ink", note: "" }) : null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Check a receipt</h2>
        <p className="text-sm text-cz-inkDim mt-1 leading-relaxed">
          Enter the receipt number, or scan the QR code printed on it. Anyone can do this — no account required.
        </p>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(entry.trim() ? { receipt: entry.trim() } : {});
          void lookup(entry);
        }}
      >
        <div>
          <label className="label" htmlFor="receipt">Receipt number</label>
          <input
            id="receipt"
            className="input tabular-nums"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="e.g. FBR20260729000000003"
            autoComplete="off"
          />
        </div>
        <button className="btn" type="submit" disabled={busy || entry.trim() === ""}>
          {busy ? "Checking…" : "Check this receipt"}
        </button>
      </form>

      {error && <div className="card p-4 text-sm bg-red-50 border-red-200 text-red-800">{error}</div>}

      {notFound && (
        <div className="card p-4 space-y-1">
          <div className="font-semibold text-red-800">No such receipt</div>
          <p className="text-sm text-cz-inkDim leading-relaxed">
            Nothing was ever issued under that number. Check the digits — and treat a receipt that cannot be found here as one
            that should not be relied on.
          </p>
        </div>
      )}

      {result && state && (
        <div className={`card p-5 space-y-3 ${state.tone}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs uppercase tracking-widest opacity-70">Status</span>
            <span className="text-xl font-bold">{state.label}</span>
          </div>
          <dl className="text-sm space-y-1.5 pt-2 border-t border-current/15">
            <div className="flex justify-between gap-3">
              <dt className="opacity-70">Receipt</dt>
              <dd className="font-medium tabular-nums text-right">{result.receipt_no}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="opacity-70">Issued by</dt>
              <dd className="font-medium text-right">{result.agency_name}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="opacity-70">Business date</dt>
              <dd className="font-medium tabular-nums text-right">{result.business_date}</dd>
            </div>
          </dl>
          {state.note && <p className="text-sm leading-relaxed pt-2 border-t border-current/15">{state.note}</p>}
        </div>
      )}

      <p className="text-xs text-cz-inkDim leading-relaxed">
        Only the agency, the date and the status are shown here. The payer's name, the amount and what was paid for are never
        disclosed to someone holding only a receipt number.
      </p>
    </div>
  );
}
