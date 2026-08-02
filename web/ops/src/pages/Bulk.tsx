import { useRef, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Notice, PageHead, Status } from "../ui.js";

interface Row { row_no: number; psid: string; amount_minor: number; outcome: string; error_code: string | null }
interface Result { batch_id: string; bulk_reference: string; status: string; rejection_reason: string | null; rows: Row[] }

export default function Bulk(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [confirmed, setConfirmed] = useState<{ payment_id: string; settled_count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setError(null); setResult(null); setConfirmed(null); setBusy(true);
    try {
      const content = await file.text();
      const rows = content.trim().split("\n").slice(1).map((line) => {
        const [rowNo, psid, amount] = line.split(",");
        return { row_no: Number(rowNo), psid: psid!, amount_minor: Number(amount) };
      });
      setResult(await api.post<Result>("/internal/bulk-payments/validate", {
        rows,
        declared_row_count: rows.length,
        declared_total_minor: rows.reduce((s, r) => s + r.amount_minor, 0),
        file_content: content,
      }, { idempotent: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function confirm(): Promise<void> {
    if (!result) return;
    setBusy(true); setError(null);
    try {
      setConfirmed(await api.post<{ payment_id: string; settled_count: number }>(`/internal/bulk-payments/${result.batch_id}/confirm`, { value_date: date }, { idempotent: false }));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  const invalid = result?.rows.filter((r) => r.outcome !== "VALID") ?? [];

  return (
    <div>
      <PageHead
        title="Bulk corporate payment file"
        note="One credit against many bills. The whole file is validated before anything is committed, and by default a single bad row rejects the entire file — a corporate payer is making one statement about their total payment, so silently applying the good rows would leave their own reconciliation wrong without them noticing."
      />

      {error && <Notice tone="bad">{error}</Notice>}

      <div className="panel p-3 mb-3">
        <label className="label" htmlFor="file">Payment file (CSV)</label>
        <input id="file" ref={fileInput} type="file" accept=".csv" onChange={handleFile} disabled={busy} />
        {fileName && <div className="text-[11px] text-op-inkDim mt-1">{fileName}</div>}
      </div>

      {result && (
        <div className="panel">
          <div className="panel-head flex items-center justify-between">
            <span className="ref normal-case tracking-normal text-[13px] font-bold">{result.bulk_reference}</span>
            <Status value={result.status} />
          </div>
          {result.rejection_reason && (
            <div className="px-3 py-2 text-op-bad border-b border-op-rule">
              {invalid.length} row(s) failed validation — {result.rejection_reason}
            </div>
          )}
          <table className="grid-table">
            <thead><tr><th style={{ width: "4rem" }}>Row</th><th>PSID</th><th className="num">Amount</th><th>Outcome</th></tr></thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.row_no}>
                  <td className="tabular-nums">{r.row_no}</td>
                  <td className="ref">{r.psid}</td>
                  <td className="num">{pkr(r.amount_minor)}</td>
                  <td>
                    <span className={`badge ${r.outcome === "VALID" ? "badge-good" : "badge-bad"}`}>{r.outcome}</span>
                    {r.error_code && <span className="ml-1.5 text-[11px] text-op-inkDim">{r.error_code}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-3">
            {result.status !== "REJECTED" && !confirmed && (
              <button className="btn" disabled={busy} onClick={confirm}>
                Confirm — post one payment, {result.rows.length} allocations
              </button>
            )}
            {confirmed && (
              <Notice tone="good">
                One credit posted, {confirmed.settled_count} bills settled from it.
              </Notice>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
