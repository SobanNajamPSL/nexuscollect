import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatPKR } from "../lib/api.js";

interface PaymentDto {
  payment_reference: string;
  status: string;
  gross_amount_minor: number;
  unapplied_amount_minor: number;
  currency: string;
  value_date: string;
  settled_psids: string[];
}
interface ReceiptDto {
  receipt_no: string;
  business_date: string;
  status: string;
}

export default function Receipt() {
  const { paymentReference } = useParams();
  const [payment, setPayment] = useState<PaymentDto | null>(null);
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!paymentReference) return;
    api.get<PaymentDto>(`/v1/payments/${paymentReference}`).then(setPayment).catch((e) => setError(e.message));
    api.get<ReceiptDto>(`/v1/payments/${paymentReference}/receipt`).then(setReceipt).catch(() => setReceipt(null));
  }, [paymentReference]);

  if (error) return <div className="card p-4 border-red-300 bg-red-50 text-red-800">{error}</div>;
  if (!payment) return <div className="text-gov-ink/60">Loading receipt…</div>;

  const isUncertain = payment.status === "UNCERTAIN";

  return (
    <div className="max-w-xl mx-auto space-y-4">
      {isUncertain ? (
        <div className="card p-6 text-center border-amber-300 bg-amber-50">
          <div className="text-lg font-semibold text-amber-800">We're confirming your payment</div>
          <p className="text-sm text-amber-700 mt-2">This is not a failure — your bank is still finalising the transfer. Expected resolution: within a few minutes.</p>
        </div>
      ) : (
        <div className="card p-6">
          <div className="text-center border-b border-dashed border-gov-border pb-4 mb-4">
            <div className="text-xs uppercase tracking-wide text-gov-ink/60">NexusCollect — Official Receipt</div>
            <div className="text-lg font-bold mt-1">{receipt?.receipt_no ?? "Receipt pending"}</div>
          </div>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-gov-ink/60">Payment reference</dt>
            <dd className="text-right font-medium">{payment.payment_reference}</dd>
            <dt className="text-gov-ink/60">Amount</dt>
            <dd className="text-right font-medium">PKR {formatPKR(payment.gross_amount_minor)}</dd>
            <dt className="text-gov-ink/60">Value date</dt>
            <dd className="text-right font-medium">{payment.value_date}</dd>
            <dt className="text-gov-ink/60">Status</dt>
            <dd className="text-right"><span className="badge bg-green-100 text-green-800">{payment.status}</span></dd>
            {payment.settled_psids.length > 0 && (
              <>
                <dt className="text-gov-ink/60 self-start">Settled PSIDs</dt>
                <dd className="text-right">{payment.settled_psids.map((p) => <div key={p}>{p}</div>)}</dd>
              </>
            )}
          </dl>
          <p className="text-center text-xs text-gov-ink/50 mt-4 border-t border-dashed border-gov-border pt-4">
            This is a system-generated receipt.
          </p>
        </div>
      )}
      <div className="text-center">
        <Link to="/" className="btn-secondary">Back to payment lookup</Link>
      </div>
    </div>
  );
}
