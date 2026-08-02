import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { displayName } from "@shared/personas.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Overview {
  businessDate: string;
  scrolls: {
    agencyCode: string;
    scrollReference: string;
    controlTotalMinor: number;
    status: string;
    ackStatus: string;
  }[];
  sweeps: { agencyCode: string; paymentReference: string; amountMinor: number }[];
}

interface PreCloseChecks {
  passed: boolean;
  failures: string[];
}

interface ScrollResult {
  scroll_reference: string;
  record_count: number;
  control_total_minor: number;
  detail_sha256: string;
  full_text: string;
}

export default function Treasury(): JSX.Element {
  const { current } = usePersona();
  const agency = current?.agency_code;
  const clock = useDemoClock();
  const date = businessDate(clock);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [checks, setChecks] = useState<PreCloseChecks | null>(null);
  const [scroll, setScroll] = useState<ScrollResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!date) return;
    setError(null);
    try {
      const [o, c] = await Promise.all([
        api.get<Overview>(`/internal/settlement/overview?business_date=${date}`),
        api.get<PreCloseChecks>(`/internal/settlement/pre-close-checks?business_date=${date}`),
      ]);
      setOverview(o);
      setChecks(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<string>): Promise<void> {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const generateScroll = (): Promise<void> =>
    run("scroll", async () => {
      const res = await api.post<ScrollResult>(`/internal/settlement/${agency}/scroll`, { business_date: date });
      setScroll(res);
      return `Scroll ${res.scroll_reference} generated — ${res.record_count} lines, control total ${pkr(res.control_total_minor)}.`;
    });

  const sweep = (): Promise<void> =>
    run("sweep", async () => {
      const res = await api.post<{ swept_amount_minor: number; scroll_reference: string; record_count: number }>(
        `/internal/settlement/${agency}/sweep`,
        { business_date: date },
      );
      return `Swept ${pkr(res.swept_amount_minor)} to treasury against scroll ${res.scroll_reference} (${res.record_count} lines).`;
    });

  const ourScrolls = overview?.scrolls.filter((s) => s.agencyCode === agency) ?? [];
  const ourSweeps = overview?.sweeps.filter((s) => s.agencyCode === agency) ?? [];

  return (
    <div className="space-y-6">
      <PageHead
        title="Treasury & scrolls"
        right={<span className="text-xs text-ag-inkDim">Business date {date ?? "…"}</span>}
        note="The formal hand-off to treasury. A scroll carries one line per allocation and is never emitted unless its control total ties exactly to the ledger — if the numbers disagree by a single paisa, the platform refuses to produce the document rather than send treasury something that might be wrong."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <section className="sheet">
        <div className="sheet-head">Today’s hand-off</div>
        <div className="p-4 flex flex-wrap items-center gap-3">
          <button className="btn" disabled={busy !== null} onClick={generateScroll}>
            {busy === "scroll" ? "Generating…" : "Generate scroll"}
          </button>
          <button className="btn-secondary" disabled={busy !== null} onClick={sweep}>
            {busy === "sweep" ? "Sweeping…" : "Run sweep to treasury"}
          </button>
          <span className="text-[12px] text-ag-inkDim max-w-lg">
            Provisional funds — anything behind an uncleared cheque — are excluded from every sweep regardless of how long
            they have been sitting as confirmed.
          </span>
        </div>
      </section>

      <section className="sheet">
        <div className="sheet-head">Scrolls — {date}</div>
        {ourScrolls.length === 0 ? (
          <Empty>No scroll generated for this business date yet.</Empty>
        ) : (
          <table className="statement">
            <thead>
              <tr>
                <th>Scroll reference</th>
                <th className="num">Control total</th>
                <th>Status</th>
                <th>Treasury acknowledgement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ourScrolls.map((s) => (
                <tr key={s.scrollReference}>
                  <td className="font-mono text-[13px]">{s.scrollReference}</td>
                  <td className="num">{pkr(s.controlTotalMinor)}</td>
                  <td>
                    <Status value={s.status} />
                  </td>
                  <td>
                    <Status value={s.ackStatus} />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {scroll && (
        <section className="sheet">
          <div className="sheet-head">
            Scroll {scroll.scroll_reference} — as transmitted
          </div>
          <div className="p-4 space-y-2">
            <div className="flex flex-wrap gap-6 text-[12px]">
              <span>
                <span className="text-ag-inkDim">Lines</span>{" "}
                <span className="tabular-nums font-semibold">{scroll.record_count}</span>
              </span>
              <span>
                <span className="text-ag-inkDim">Control total</span>{" "}
                <span className="tabular-nums font-semibold">{pkr(scroll.control_total_minor)}</span>
              </span>
              <span>
                <span className="text-ag-inkDim">Detail SHA-256</span>{" "}
                <span className="font-mono">{scroll.detail_sha256.slice(0, 16)}…</span>
              </span>
            </div>
            <pre className="bg-white border border-ag-rule rounded-sm p-3 text-[11px] font-mono overflow-x-auto max-h-72 leading-relaxed">
              {scroll.full_text}
            </pre>
            <p className="text-[11px] text-ag-inkDim">
              The hash covers the detail lines, so treasury can prove the file it received is the file that was signed.
            </p>
          </div>
        </section>
      )}

      {ourSweeps.length > 0 && (
        <section className="sheet">
          <div className="sheet-head">Transfers to treasury — {date}</div>
          <table className="statement">
            <thead>
              <tr>
                <th>Payment reference</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {ourSweeps.map((s) => (
                <tr key={s.paymentReference}>
                  <td className="font-mono text-[13px]">{s.paymentReference}</td>
                  <td className="num">{pkr(s.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total swept</td>
                <td className="num">{pkr(ourSweeps.reduce((s, x) => s + x.amountMinor, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      <PeriodClose checks={checks} agency={agency ?? ""} actor={current ? displayName(current) : ""} onDone={load} />
    </div>
  );
}

function PeriodClose({
  checks,
  agency,
  actor,
  onDone,
}: {
  checks: PreCloseChecks | null;
  agency: string;
  actor: string;
  onDone: () => Promise<void>;
}): JSX.Element {
  const [start, setStart] = useState("2026-07-01");
  const [end, setEnd] = useState("2026-07-31");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState<string | null>(null);

  async function close(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ period_id: string }>("/internal/settlement/period-close", {
        period_start: start,
        period_end: end,
        closed_by: actor || "agency-portal",
      });
      setPeriodId(res.period_id);
      setResult("Period closed. It can never be reopened — a closed financial period is not revisable after the fact.");
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function signOff(): Promise<void> {
    if (!periodId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/internal/settlement/period/${periodId}/signoff`, {
        agency_code: agency,
        signed_off_by: actor || "agency-portal",
      });
      setResult("Signed off on behalf of this agency.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sheet">
      <div className="sheet-head">Period close</div>
      <div className="p-4 space-y-4">
        {checks && (
          <div
            className={`sheet p-3 text-sm ${
              checks.passed ? "border-ag-good/40 bg-ag-good/[0.05]" : "border-ag-warn/40 bg-ag-warn/[0.05]"
            }`}
          >
            <div className={`font-semibold ${checks.passed ? "text-ag-good" : "text-ag-warn"}`}>
              {checks.passed ? "Pre-close checks pass" : "Pre-close checks block this close"}
            </div>
            {!checks.passed && (
              <ul className="list-disc list-inside mt-1.5 text-ag-ink/80 text-[13px]">
                {checks.failures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-ag-inkDim mt-2">
              A period cannot be closed while a critical or high-severity reconciliation break is open, or while a payment
              is still unconfirmed. This is a hard control, not a warning.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="period-start">
              Period start
            </label>
            <input id="period-start" className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="period-end">
              Period end
            </label>
            <input id="period-end" className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <button className="btn" disabled={busy} onClick={close}>
            {busy ? "Working…" : "Close period"}
          </button>
          {periodId && (
            <button className="btn-secondary" disabled={busy} onClick={signOff}>
              Sign off as {agency}
            </button>
          )}
        </div>

        {error && <Notice tone="bad">{error}</Notice>}
        {result && <Notice tone="good">{result}</Notice>}
      </div>
    </section>
  );
}
