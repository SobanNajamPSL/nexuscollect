import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface ReportMeta { id: string; name: string }

const DEFAULT_PARAMS: Record<string, Record<string, string>> = {
  r01: { business_date: "2026-07-30" },
  r02: { period_start: "2026-07-30", period_end: "2026-07-30", agency_code: "FBR" },
  r03: { business_date: "2026-07-30" },
  r04: { as_of_date: "2026-07-30" },
  r05: { business_date: "2026-07-30" },
  r06: { as_of_date: "2026-07-30" },
  r07: { as_of_date: "2026-07-30" },
  r10: { period_start: "2026-07-01", period_end: "2026-07-31" },
  r11: { period_start: "2026-07-01", period_end: "2026-07-31" },
  r14: { agency_code: "FBR", period_start: "2026-07-01", period_end: "2026-07-31" },
  r18: { agency_code: "FBR", fiscal_year_start: "2026-07-01", fiscal_year_end: "2027-06-30" },
};

export default function ReportCentre() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<ReportMeta[]>("/internal/reports").then(setReports).catch((e) => setError(e.message));
  }, []);

  async function run(id: string) {
    setSelected(id);
    setResult(null);
    setError(null);
    try {
      const params = new URLSearchParams(DEFAULT_PARAMS[id] ?? {});
      setResult(await api.get(`/internal/reports/${id}${params.toString() ? `?${params.toString()}` : ""}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Report centre</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Run any of the 18 standard reports (§21.1) against real data.</p>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      <div className="grid grid-cols-3 gap-2">
        {reports.map((r) => (
          <button key={r.id} className={`card p-3 text-left text-sm hover:bg-gray-50 ${selected === r.id ? "border-gov-primary" : ""}`} onClick={() => run(r.id)}>
            <div className="font-semibold uppercase">{r.id}</div>
            <div className="text-xs text-gov-ink/60">{r.name}</div>
          </button>
        ))}
      </div>

      {result !== null && (
        <div className="card p-4">
          <div className="font-semibold mb-2">{selected?.toUpperCase()} result</div>
          <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto max-h-96">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
