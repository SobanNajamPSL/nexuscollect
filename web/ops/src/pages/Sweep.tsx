import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Overview {
  businessDate: string;
  scrolls: { id: string; agencyCode: string; scrollReference: string; controlTotalMinor: number; status: string; ackStatus: string | null }[];
  sweeps: { agencyCode: string; paymentReference: string; amountMinor: number }[];
}
interface Agency { code: string; name: string }

/**
 * The operator's half of settlement: running sweeps and generating scrolls
 * across every agency. An agency's own view of *its* scrolls, and its period
 * sign-off, live in the agency portal — the same underlying records, seen from
 * the side that owns the decision.
 */
export default function Sweep(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [agencyCode, setAgencyCode] = useState("FBR");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!date) return;
    setError(null);
    try {
      const [o, a] = await Promise.all([
        api.get<Overview>(`/internal/settlement/overview?business_date=${date}`),
        api.get<Agency[]>("/internal/agencies"),
      ]);
      setOverview(o);
      setAgencies(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  async function act(kind: "sweep" | "scroll"): Promise<void> {
    setBusy(kind); setError(null); setDone(null);
    try {
      if (kind === "sweep") {
        const r = await api.post<{ swept_amount_minor: number; scroll_reference: string }>(`/internal/settlement/${agencyCode}/sweep`, { business_date: date }, { idempotent: false });
        setDone(`${agencyCode}: swept ${pkr(r.swept_amount_minor)} against scroll ${r.scroll_reference}.`);
      } else {
        const r = await api.post<{ scroll_reference: string; record_count: number; control_total_minor: number }>(`/internal/settlement/${agencyCode}/scroll`, { business_date: date }, { idempotent: false });
        setDone(`${agencyCode}: scroll ${r.scroll_reference} — ${r.record_count} lines, control total ${pkr(r.control_total_minor)}.`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  /** Treasury responds to a scroll; a rejection becomes a B09 classification
   *  break rather than a cash-missing alarm — the money is banked, just misfiled. */
  async function ack(scrollId: string, status: "ACCEPTED" | "REJECTED"): Promise<void> {
    setBusy(scrollId); setError(null); setDone(null);
    try {
      await api.post(`/internal/settlement/scroll/${scrollId}/ack`, { ack_status: status });
      setDone(
        status === "ACCEPTED"
          ? "Treasury acknowledged the scroll."
          : "Treasury rejection recorded — this raises a classification break, not a missing-cash alarm.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  return (
    <div>
      <PageHead
        title="Sweep operations"
        right={
          <span className="flex items-end gap-2">
            <select className="select w-44" value={agencyCode} onChange={(e) => setAgencyCode(e.target.value)}>
              {agencies.map((a) => <option key={a.code} value={a.code}>{a.code}</option>)}
            </select>
            <button className="btn-secondary" disabled={busy !== null} onClick={() => act("scroll")}>
              {busy === "scroll" ? "…" : "Generate scroll"}
            </button>
            <button className="btn" disabled={busy !== null} onClick={() => act("sweep")}>
              {busy === "sweep" ? "Sweeping…" : "Run sweep"}
            </button>
          </span>
        }
        note="Moves confirmed money out of the collection account into government treasury, one agency at a time. Provisional funds behind an uncleared instrument are never sweepable, and a scroll is refused outright unless its control total ties to the ledger exactly."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <section className="panel mb-3">
        <div className="panel-head">Scrolls — {date}</div>
        {!overview || overview.scrolls.length === 0 ? <Empty>No scroll generated for this business date.</Empty> : (
          <table className="grid-table">
            <thead><tr><th>Agency</th><th>Scroll</th><th className="num">Control total</th><th>Status</th><th>Treasury ack</th><th style={{ width: "11rem" }} /></tr></thead>
            <tbody>
              {overview.scrolls.map((s) => (
                <tr key={s.scrollReference}>
                  <td className="font-semibold">{s.agencyCode}</td>
                  <td className="ref">{s.scrollReference}</td>
                  <td className="num">{pkr(s.controlTotalMinor)}</td>
                  <td><Status value={s.status} /></td>
                  <td><Status value={s.ackStatus} /></td>
                  <td>
                    {!s.ackStatus && (
                      <span className="flex gap-1">
                        <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => ack(s.id, "ACCEPTED")}>Ack accepted</button>
                        <button className="btn-secondary btn-xs" disabled={busy !== null} onClick={() => ack(s.id, "REJECTED")}>Rejected</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">Transfers to treasury — {date}</div>
        {!overview || overview.sweeps.length === 0 ? <Empty>Nothing swept for this business date.</Empty> : (
          <table className="grid-table">
            <thead><tr><th>Agency</th><th>Payment</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {overview.sweeps.map((s) => (
                <tr key={s.paymentReference}>
                  <td className="font-semibold">{s.agencyCode}</td>
                  <td className="ref">{s.paymentReference}</td>
                  <td className="num">{pkr(s.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="px-2.5 py-1.5 border-t border-op-rule font-semibold">Total</td>
                <td className="num border-t border-op-rule font-semibold">{pkr(overview.sweeps.reduce((s, x) => s + x.amountMinor, 0))}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </div>
  );
}
