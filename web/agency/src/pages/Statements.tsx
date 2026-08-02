import { useState } from "react";
import { api } from "@shared/api.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Notice, PageHead } from "../ui.js";

/**
 * The subset of the eighteen standard reports an agency actually reads.
 *
 * The other thirteen are operational — break ageing, channel performance, fee
 * revenue, the control pack — and belong to the operator console. Putting all
 * eighteen behind one grid, as the old single-window build did, meant neither
 * audience had a report list that was about them.
 */
interface ReportDef {
  id: string;
  title: string;
  what: string;
  params: (ctx: { agency: string; date: string }) => Record<string, string>;
}

const REPORTS: ReportDef[] = [
  {
    id: "r02",
    title: "R02 — Head-wise collection statement",
    what: "Collections broken down by revenue head. This is the report treasury actually uses.",
    params: ({ agency, date }) => ({ period_start: date, period_end: date, agency_code: agency }),
  },
  {
    id: "r05",
    title: "R05 — Settlement & sweep report",
    what: "The detail behind each sweep cycle and the scroll that documented it.",
    params: ({ date }) => ({ business_date: date }),
  },
  {
    id: "r07",
    title: "R07 — Outstanding assessments ageing",
    what: "How overdue unpaid bills are, bucketed by age.",
    params: ({ date }) => ({ as_of_date: date }),
  },
  {
    id: "r14",
    title: "R14 — Period statement",
    what: "A formal agency-level statement for an accounting period.",
    params: ({ agency }) => ({ agency_code: agency, period_start: "2026-07-01", period_end: "2026-07-31" }),
  },
  {
    id: "r18",
    title: "R18 — Fiscal year certificate",
    what: "A cryptographically signed certificate of a full fiscal year's collections.",
    params: ({ agency }) => ({ agency_code: agency, fiscal_year_start: "2026-07-01", fiscal_year_end: "2027-06-30" }),
  },
];

export default function Statements(): JSX.Element {
  const { current } = usePersona();
  const clock = useDemoClock();
  const date = businessDate(clock);
  const agency = current?.agency_code;

  const [selected, setSelected] = useState<ReportDef | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(def: ReportDef): Promise<void> {
    if (!agency || !date) return;
    setSelected(def);
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const params = new URLSearchParams(def.params({ agency, date }));
      setResult(await api.get(`/internal/reports/${def.id}?${params.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHead
        title="Statements"
        note="Every figure in every one of these is produced by a live query against the ledger at the moment you run it — never a stored export. Run the same statement twice and it recomputes twice."
      />

      <div className="grid grid-cols-2 gap-3 mb-6">
        {REPORTS.map((r) => (
          <button
            key={r.id}
            className={`sheet p-3 text-left hover:bg-ag-panelAlt transition-colors ${
              selected?.id === r.id ? "border-ag-primary" : ""
            }`}
            onClick={() => run(r)}
          >
            <div className="font-semibold text-[13px]">{r.title}</div>
            <div className="text-[12px] text-ag-inkDim mt-0.5 leading-snug">{r.what}</div>
          </button>
        ))}
      </div>

      {error && <Notice tone="bad">{error}</Notice>}

      {selected && (
        <section className="sheet">
          <div className="sheet-head">{selected.title}</div>
          {busy ? (
            <div className="p-4 text-sm text-ag-inkDim">Running…</div>
          ) : (
            <pre className="p-4 text-[11px] font-mono overflow-x-auto max-h-[32rem] leading-relaxed">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
