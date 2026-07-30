import { useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface BreakDto {
  break_code: string;
  type: string;
  severity: string;
  amount_minor: number;
  source_ref: string;
  narrative: string | null;
  auto_resolvable: boolean;
}
interface ReconResult {
  run_id: string;
  break_count: number;
  breaks: BreakDto[];
}

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white",
  HIGH: "bg-red-100 text-red-800",
  MEDIUM: "bg-amber-100 text-amber-800",
  LOW: "bg-blue-100 text-blue-800",
  INFO: "bg-gray-100 text-gray-600",
};

export default function BreakRegister() {
  const [result, setResult] = useState<ReconResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.post<ReconResult>("/internal/recon/run", { business_date: "2026-07-30" }, { idempotent: false }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const autoResolved = result?.breaks.filter((b) => b.auto_resolvable) ?? [];
  const openBreaks = result?.breaks.filter((b) => !b.auto_resolvable) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gov-primaryDark">Break register — 2026-07-30</h1>
          <p className="text-sm text-gov-ink/70 mt-1">Three-way reconciliation: bank statement, switch settlement, rail settlement.</p>
        </div>
        <button className="btn" disabled={loading} onClick={run}>{loading ? "Running…" : "Run reconciliation"}</button>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {result && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-4 text-center">
              <div className="text-3xl font-bold">{result.break_count}</div>
              <div className="text-xs text-gov-ink/60">Total breaks found</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-3xl font-bold text-green-700">{autoResolved.length}</div>
              <div className="text-xs text-gov-ink/60">Auto-resolved</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-3xl font-bold text-red-700">{openBreaks.length}</div>
              <div className="text-xs text-gov-ink/60">Requiring attention</div>
            </div>
          </div>

          {openBreaks.length > 0 && (
            <div className="card divide-y divide-gov-border">
              <div className="p-3 font-semibold bg-gray-50">Open breaks</div>
              {openBreaks.map((b, i) => (
                <div key={i} className="p-4 flex justify-between items-start gap-4">
                  <div>
                    <div className="flex gap-2 items-center">
                      <span className="font-mono text-xs bg-gov-primary text-white rounded px-1.5 py-0.5">{b.break_code}</span>
                      <span className="font-medium">{b.type.replaceAll("_", " ")}</span>
                    </div>
                    <div className="text-xs text-gov-ink/60 mt-1">{b.source_ref}</div>
                    {b.narrative && <div className="text-xs text-gov-ink/60 italic mt-0.5">"{b.narrative}"</div>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-semibold">PKR {formatPKR(b.amount_minor)}</div>
                    <span className={`badge mt-1 ${SEVERITY_COLOR[b.severity]}`}>{b.severity}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {autoResolved.length > 0 && (
            <div className="card divide-y divide-gov-border opacity-70">
              <div className="p-3 font-semibold bg-gray-50">Auto-resolved (no action needed)</div>
              {autoResolved.map((b, i) => (
                <div key={i} className="p-3 flex justify-between items-center text-sm">
                  <div>
                    <span className="font-mono text-xs bg-gray-300 text-gray-700 rounded px-1.5 py-0.5 mr-2">{b.break_code}</span>
                    {b.type.replaceAll("_", " ")} — {b.source_ref}
                  </div>
                  <span className="text-green-700 text-xs">✓ resolved</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
