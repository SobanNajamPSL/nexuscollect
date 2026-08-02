import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";

/**
 * More than one receipt, from one payment action.
 *
 * A payer who looks up one reference and taps once may owe money to several
 * agencies. They get a receipt from each, because that is what actually happened:
 * a payment belongs to one agency and is swept into one treasury account (§6.4),
 * so two agencies means two payments and two pieces of evidence — each with its
 * own gapless per-agency receipt number.
 *
 * Presenting that plainly is better than hiding it. The single most common
 * question a finance officer asks about a shared collection platform is "how do I
 * know my money is mine", and this screen is the payer-side answer.
 */

interface Summary {
  reference: string;
  receiptNo: string | null;
  agencyName: string | null;
  amountMinor: number;
  status: string;
}

export default function Receipts(): JSX.Element {
  const [params] = useSearchParams();
  const refs = (params.get("refs") ?? "").split(",").filter(Boolean);
  const [rows, setRows] = useState<Summary[] | null>(null);

  useEffect(() => {
    if (refs.length === 0) return;
    let live = true;
    void (async () => {
      const loaded = await Promise.all(
        refs.map(async (reference): Promise<Summary> => {
          const payment = await api.get<{ gross_amount_minor: number; status: string }>(`/v1/payments/${reference}`);
          const receipt = await api.get<{ receipt_no: string }>(`/v1/payments/${reference}/receipt`).catch(() => null);
          let agencyName: string | null = null;
          if (receipt) {
            const verified = await api.get<{ agency_name: string }>(`/v1/verify/${receipt.receipt_no}`).catch(() => null);
            agencyName = verified?.agency_name ?? null;
          }
          return { reference, receiptNo: receipt?.receipt_no ?? null, agencyName, amountMinor: payment.gross_amount_minor, status: payment.status };
        }),
      );
      if (live) setRows(loaded);
    })();
    return () => {
      live = false;
    };
  }, [params]);

  if (refs.length === 0) {
    return (
      <div className="space-y-4">
        <div className="card p-4 text-sm text-cz-inkDim">No receipts to show.</div>
        <Link to="/" className="btn-secondary">Pay a bill</Link>
      </div>
    );
  }

  if (!rows) return <div className="text-sm text-cz-inkDim">Loading your receipts…</div>;

  const total = rows.reduce((s, r) => s + r.amountMinor, 0);

  return (
    <div className="space-y-5">
      <div className="card p-5 bg-emerald-50 border-emerald-200">
        <div className="text-sm text-emerald-900">Paid</div>
        <div className="text-2xl font-semibold text-emerald-900 mt-1 tabular-nums">{pkr(total)}</div>
        <p className="text-xs text-emerald-800 mt-2 leading-relaxed">
          Your bills belonged to {rows.length} different agencies, so you have {rows.length} receipts — one from each. Every one
          of them can be verified independently.
        </p>
      </div>

      <div className="space-y-2">
        {rows.map((r) => (
          <Link key={r.reference} to={`/receipt/${r.reference}`} className="payable block hover:border-cz-primary/40 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium leading-snug">{r.agencyName ?? "Receipt"}</div>
                <div className="text-xs text-cz-inkDim tabular-nums mt-1">{r.receiptNo ?? r.reference}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="amount">{pkr(r.amountMinor)}</div>
                <span className="badge badge-paid mt-1">Paid</span>
              </div>
            </div>
            <div className="text-xs text-cz-primary underline underline-offset-2 mt-2">View this receipt</div>
          </Link>
        ))}
      </div>

      <Link to="/" className="btn-secondary">Pay another bill</Link>
    </div>
  );
}
