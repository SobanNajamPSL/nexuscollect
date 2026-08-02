import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Notice, PageHead } from "../ui.js";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
  formula: string;
}

/**
 * §10.8's five reperformance checks.
 *
 * The "break the chain" button that used to live on this screen has moved to the
 * demonstration harness, where it belongs: no operations user has a control that
 * deliberately corrupts the ledger, and pretending otherwise made an assurance
 * screen look like a security hole.
 */
export default function Controls(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (!date) return;
    setBusy(true);
    setError(null);
    try {
      const [tb, ai, br, lvs, vc] = await Promise.all([
        api.get<{ balanced: boolean; total_debit_minor: number; total_credit_minor: number }>(`/internal/control/trial-balance?date=${date}`),
        api.get<{ passed: boolean; checked_count: number; excluded_statuses: string[] }>("/internal/control/allocation-integrity"),
        api.get<{ passed: boolean; checked_count: number }>("/internal/control/balance-rebuild"),
        api.get<{ passed: boolean; checked_agency_count: number }>("/internal/control/ledger-vs-subledger"),
        api.get<{ intact: boolean; break: unknown }>("/internal/ledger/verify-chain"),
      ]);
      setChecks([
        {
          name: "Trial balance ties",
          passed: tb.balanced,
          formula: "Σ debits = Σ credits",
          detail: `DR ${pkr(tb.total_debit_minor)} against CR ${pkr(tb.total_credit_minor)}`,
        },
        {
          name: "Allocation integrity",
          passed: ai.passed,
          formula: "Σ applied allocations + unapplied = gross, per payment",
          detail: `${ai.checked_count} payments checked; ${ai.excluded_statuses.join(" and ")} excluded by design`,
        },
        {
          name: "Balance rebuild",
          passed: br.passed,
          formula: "recomputed balance = cached balance, byte for byte",
          detail: `${br.checked_count} assessments rebuilt from their allocations`,
        },
        {
          name: "Ledger vs sub-ledger",
          passed: lvs.passed,
          formula: "agency payable balance = Σ unswept allocations",
          detail: `${lvs.checked_agency_count} agencies reconciled`,
        },
        {
          name: "Hash chain intact",
          passed: vc.intact,
          formula: "hash_self = SHA256(entry_no ‖ lines ‖ hash_prev), walked from genesis",
          detail: vc.intact ? "verified from the first entry" : `tampering detected: ${JSON.stringify(vc.break)}`,
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [date]);

  useEffect(() => {
    void run();
  }, [run]);

  const failing = checks?.filter((c) => !c.passed) ?? [];

  return (
    <div>
      <PageHead
        title="Control assertions"
        right={
          <button className="btn" disabled={busy} onClick={run}>
            {busy ? "Re-performing…" : "Re-perform all five"}
          </button>
        }
        note="Every figure here is recomputed against the live ledger the moment you ask, never read from a cache. That is what makes them assertions rather than a status page — a stored 'all green' proves nothing."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {checks && failing.length > 0 && (
        <Notice tone="bad">
          {failing.length} of five checks failed. The chain check names the specific entry it disagrees with, so a
          failure is locatable rather than merely alarming.
        </Notice>
      )}
      {checks && failing.length === 0 && (
        <Notice tone="good">All five checks pass against the live ledger as of {date}.</Notice>
      )}

      <div className="panel">
        <table className="grid-table">
          <thead>
            <tr>
              <th style={{ width: "14rem" }}>Assertion</th>
              <th>What is re-performed</th>
              <th>Result</th>
              <th style={{ width: "6rem" }} />
            </tr>
          </thead>
          <tbody>
            {(checks ?? []).map((c) => (
              <tr key={c.name}>
                <td className="font-semibold">{c.name}</td>
                <td className="font-mono text-[11px] text-op-inkDim">{c.formula}</td>
                <td>{c.detail}</td>
                <td>
                  <span className={`badge ${c.passed ? "badge-good" : "badge-bad"}`}>{c.passed ? "pass" : "fail"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!checks && <div className="px-3 py-4 text-op-inkDim">Re-performing…</div>}
      </div>
    </div>
  );
}
