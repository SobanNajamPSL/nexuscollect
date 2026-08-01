import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Run { id: string; business_date: string; recon_type: string; status: string; break_count: number }

export default function ReconConsole() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setRuns(await api.get<Run[]>("/internal/recon/runs"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function trigger() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/internal/recon/run", { business_date: "2026-07-30" }, { idempotent: false });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gov-primaryDark">Recon run console</h1>
          <p className="text-sm text-gov-ink/70 mt-1">Trigger, monitor, and compare reconciliation runs. Re-running is idempotent — identical matches, identical breaks.</p>
        </div>
        <button disabled={busy} className="btn" onClick={trigger}>{busy ? "Running…" : "Run 2026-07-30"}</button>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}
      <div className="card">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gov-ink/60 border-b border-gov-border"><th className="p-3">Business date</th><th className="p-3">Type</th><th className="p-3">Status</th><th className="p-3 text-right">Breaks</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-gov-border last:border-0">
                <td className="p-3">{r.business_date}</td><td className="p-3">{r.recon_type}</td><td className="p-3">{r.status}</td>
                <td className="p-3 text-right">{r.break_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
