import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface Approval {
  id: string; subject_type: string; action: string; amount_minor: number | null; state: string; maker_user_id: string; maker_at: string;
  refund_preview: { refund_reference: string; mode: string; payment_reference: string } | null;
}

export default function ApprovalsInbox() {
  const [rows, setRows] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Approval[]>("/internal/approvals?state=PENDING").then(setRows).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Approvals inbox</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Everything awaiting a checker, with a journal preview — maker and checker can never be the same user (enforced by the database).</p>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}
      <div className="card divide-y divide-gov-border">
        {rows.map((a) => (
          <div key={a.id} className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{a.action} — {a.subject_type}</div>
                <div className="text-xs text-gov-ink/60">Proposed by {a.maker_user_id} at {new Date(a.maker_at).toLocaleString()}</div>
              </div>
              {a.amount_minor !== null && <div className="font-medium">PKR {formatPKR(a.amount_minor)}</div>}
            </div>
            {a.refund_preview && (
              <div className="mt-2 text-xs bg-gray-50 rounded p-2">
                Refund {a.refund_preview.refund_reference} ({a.refund_preview.mode}) against payment {a.refund_preview.payment_reference}
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-sm text-gov-ink/60">Nothing pending approval.</div>}
      </div>
    </div>
  );
}
