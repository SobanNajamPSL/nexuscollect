import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Run { id: string; business_date: string; recon_type: string; status: string; break_count: number }

export default function ReconRuns(): JSX.Element {
  const clock = useDemoClock();
  const date = businessDate(clock);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await api.get<Run[]>("/internal/recon/runs"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function trigger(): Promise<void> {
    setBusy(true); setError(null); setDone(null);
    try {
      const res = await api.post<{ break_count: number }>("/internal/recon/run", { business_date: date }, { idempotent: false });
      setDone(`Run complete for ${date} — ${res.break_count} breaks.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHead
        title="Recon console"
        right={<button className="btn" disabled={busy || !date} onClick={trigger}>{busy ? "Running…" : `Run ${date ?? ""}`}</button>}
        note="Ingests the bank statement, the switch settlement file and the rail settlement file for a business date and matches them against the platform's own ledger. Re-running is idempotent: the same sources produce the same matches and the same breaks, so a re-run is safe rather than duplicative."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="good">{done}</Notice>}

      <div className="panel">
        <div className="panel-head">Runs — most recent first</div>
        {runs.length === 0 ? <Empty>No reconciliation has been run.</Empty> : (
          <table className="grid-table">
            <thead>
              <tr><th>Business date</th><th>Type</th><th>Status</th><th className="num">Breaks</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="tabular-nums font-semibold">{r.business_date}</td>
                  <td>{r.recon_type}</td>
                  <td><Status value={r.status} /></td>
                  <td className="num">{r.break_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
