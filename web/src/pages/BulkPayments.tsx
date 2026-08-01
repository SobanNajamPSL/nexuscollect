import { useRef, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface ValidatedRow { row_no: number; psid: string; amount_minor: number; outcome: string; error_code: string | null }
interface ValidationResult { batch_id: string; bulk_reference: string; status: string; rejection_reason: string | null; rows: ValidatedRow[] }

export default function BulkPayments() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<{ payment_id: string; settled_count: number } | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setResult(null);
    setConfirmed(null);
    setBusy(true);
    try {
      const content = await file.text();
      const lines = content.trim().split("\n");
      const rows = lines.slice(1).map((line) => {
        const [rowNoStr, psid, amountStr] = line.split(",");
        return { row_no: Number(rowNoStr), psid: psid!, amount_minor: Number(amountStr) };
      });
      const declaredTotal = rows.reduce((s, r) => s + r.amount_minor, 0);
      const validated = await api.post<ValidationResult>("/internal/bulk-payments/validate", {
        rows, declared_row_count: rows.length, declared_total_minor: declaredTotal, file_content: content,
      }, { idempotent: false });
      setResult(validated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ payment_id: string; settled_count: number }>(`/internal/bulk-payments/${result.batch_id}/confirm`, { value_date: "2026-07-30" }, { idempotent: false });
      setConfirmed(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Bulk corporate payment file</h1>
        <p className="text-sm text-gov-ink/70 mt-1">One credit, many allocations. The whole file is validated before anything is committed — one bad row rejects the entire file by default.</p>
      </div>

      <div className="card p-4">
        <input ref={fileInput} type="file" accept=".csv" onChange={handleFile} disabled={busy} />
        {fileName && <div className="text-xs text-gov-ink/60 mt-2">{fileName}</div>}
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {result && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">{result.bulk_reference}</div>
            <span className={`badge ${result.status === "REJECTED" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-800"}`}>{result.status}</span>
          </div>
          {result.rejection_reason && <div className="text-sm text-red-700">{result.rejection_reason}</div>}
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gov-ink/60"><th className="p-2">Row</th><th className="p-2">PSID</th><th className="p-2 text-right">Amount</th><th className="p-2">Outcome</th></tr></thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.row_no} className="border-t border-gov-border">
                  <td className="p-2">{r.row_no}</td>
                  <td className="p-2">{r.psid}</td>
                  <td className="p-2 text-right">PKR {formatPKR(r.amount_minor)}</td>
                  <td className="p-2">
                    <span className={`badge text-xs ${r.outcome === "VALID" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"}`}>{r.outcome}</span>
                    {r.error_code && <span className="ml-2 text-xs text-gov-ink/60">{r.error_code}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.status !== "REJECTED" && !confirmed && (
            <button className="btn" disabled={busy} onClick={confirm}>Confirm — post one payment, {result.rows.length} allocations</button>
          )}
          {confirmed && (
            <div className="text-sm bg-green-50 text-green-800 rounded p-3">
              Payment {confirmed.payment_id} posted — {confirmed.settled_count} obligations settled from one credit.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
