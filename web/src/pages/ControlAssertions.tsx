import { useState } from "react";
import { api } from "../lib/api.js";

interface TrialBalance {
  balanced: boolean;
  total_debit_minor: number;
  total_credit_minor: number;
}
interface AllocationIntegrity {
  passed: boolean;
  checked_count: number;
  excluded_statuses: string[];
}
interface BalanceRebuild {
  passed: boolean;
  checked_count: number;
}
interface LedgerVsSubledger {
  passed: boolean;
  checked_agency_count: number;
}
interface VerifyChain {
  intact: boolean;
  break: { label: string } | null;
}

type CheckResult = { name: string; passed: boolean; detail: string };

export default function ControlAssertions() {
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [tampering, setTampering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAll() {
    setLoading(true);
    setError(null);
    try {
      const [tb, ai, br, lvs, vc] = await Promise.all([
        api.get<TrialBalance>("/internal/control/trial-balance?date=2026-07-30"),
        api.get<AllocationIntegrity>("/internal/control/allocation-integrity"),
        api.get<BalanceRebuild>("/internal/control/balance-rebuild"),
        api.get<LedgerVsSubledger>("/internal/control/ledger-vs-subledger"),
        api.get<VerifyChain>("/internal/ledger/verify-chain"),
      ]);
      setChecks([
        { name: "Trial balance ties", passed: tb.balanced, detail: `DR ${tb.total_debit_minor} = CR ${tb.total_credit_minor}` },
        { name: "Allocation integrity", passed: ai.passed, detail: `${ai.checked_count} payments checked, excludes ${ai.excluded_statuses.join("/")}` },
        { name: "Balance rebuild byte-identical", passed: br.passed, detail: `${br.checked_count} assessments rebuilt from allocations` },
        { name: "Ledger vs sub-ledger", passed: lvs.passed, detail: `${lvs.checked_agency_count} agencies checked` },
        { name: "Hash chain intact", passed: vc.intact, detail: vc.break ? `Break at ${vc.break.label}` : "verified from genesis" },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function breakChain() {
    setTampering(true);
    setError(null);
    try {
      await api.post("/internal/demo/tamper-chain", {}, { idempotent: false });
      await runAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTampering(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gov-primaryDark">Control assertions</h1>
          <p className="text-sm text-gov-ink/70 mt-1">The five reperformance checks, live — every figure below is recomputed on demand, never cached.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn" disabled={loading} onClick={runAll}>{loading ? "Running…" : "Run all checks"}</button>
          <button className="btn-secondary text-red-700 border-red-300" disabled={tampering} onClick={breakChain}>{tampering ? "Tampering…" : "Break the hash chain"}</button>
        </div>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {checks && (
        <div className="card divide-y divide-gov-border">
          {checks.map((c) => (
            <div key={c.name} className="p-4 flex items-center justify-between">
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-gov-ink/60">{c.detail}</div>
              </div>
              <span className={`badge text-sm ${c.passed ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                {c.passed ? "✓ PASS" : "✕ FAIL — see detail"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
