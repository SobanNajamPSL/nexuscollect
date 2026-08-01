import { useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDateLong, useDemoClock } from "@shared/demoClock.js";

interface Dashboard {
  agency_code: string;
  agency_name: string;
  head_wise: { head_code: string; head_name: string; allocated_minor: number }[];
  total_confirmed_minor: number;
  total_settled_minor: number;
  total_swept_minor: number;
  assessment_status_counts: { status: string; count: number; balance_total_minor: number }[];
}

const STATUS_TONE: Record<string, string> = {
  SETTLED: "badge-good",
  ISSUED: "badge-neutral",
  OVERDUE: "badge-bad",
  PARTIALLY_PAID: "badge-warn",
  EXPIRED: "badge-warn",
  CANCELLED: "badge-neutral",
  AMENDED: "badge-neutral",
};

export default function Position(): JSX.Element {
  const { current } = usePersona();
  const clock = useDemoClock();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!current?.agency_code) return;
    api
      .get<Dashboard>(`/internal/agency/${current.agency_code}/dashboard`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [current?.agency_code]);

  if (error) {
    return <div className="sheet p-4 border-ag-bad/40 bg-ag-bad/[0.04] text-ag-bad text-sm">{error}</div>;
  }
  if (!data) return <div className="text-ag-inkDim text-sm">Loading position…</div>;

  const headTotal = data.head_wise.reduce((s, h) => s + h.allocated_minor, 0);
  const outstanding = data.assessment_status_counts.reduce((s, r) => s + r.balance_total_minor, 0);

  return (
    <div className="space-y-7">
      <div className="flex items-baseline justify-between border-b border-ag-rule pb-3">
        <h1 className="doc-title text-xl">Collection position</h1>
        <div className="text-xs text-ag-inkDim">
          Business date {businessDateLong(clock) ?? "…"} · Asia/Karachi
        </div>
      </div>

      {/* The three figures the platform refuses to merge into one. This is the
          demonstration's opening argument, so it leads. */}
      <section>
        <div className="grid grid-cols-3 gap-px bg-ag-rule border border-ag-rule rounded-sm overflow-hidden">
          {[
            { label: "Confirmed", value: data.total_confirmed_minor, note: "Applied to your bills" },
            { label: "Settled", value: data.total_settled_minor, note: "Bills fully discharged" },
            { label: "Swept to treasury", value: data.total_swept_minor, note: "Cash actually transferred" },
          ].map((f) => (
            <div key={f.label} className="bg-ag-panel px-5 py-4">
              <div className="text-[11px] uppercase tracking-wider text-ag-inkDim">{f.label}</div>
              <div className="figure text-2xl mt-1.5">{pkr(f.value)}</div>
              <div className="text-[11px] text-ag-inkDim mt-1">{f.note}</div>
            </div>
          ))}
        </div>
        <p className="text-[12px] text-ag-inkDim mt-2 leading-relaxed">
          These are three separate numbers by design, never one “collected” total. Money can be confirmed against a bill
          long before it reaches the treasury account, and reporting them as one figure is how a collection system
          misstates its own position.
          {data.total_swept_minor === 0 && (
            <> Nothing has been swept for this business date yet — the sweep has not been run.</>
          )}
        </p>
      </section>

      {/* Head-wise is the report treasury actually uses. */}
      <section className="sheet">
        <div className="sheet-head">Head-wise collection — {data.agency_code}</div>
        <table className="statement">
          <thead>
            <tr>
              <th style={{ width: "7rem" }}>Head</th>
              <th>Description</th>
              <th className="num">Collected</th>
            </tr>
          </thead>
          <tbody>
            {data.head_wise.map((h) => (
              <tr key={h.head_code}>
                <td className="font-mono text-[13px]">{h.head_code}</td>
                <td>{h.head_name}</td>
                <td className="num">{pkr(h.allocated_minor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total across {data.head_wise.length} revenue heads</td>
              <td className="num">{pkr(headTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <section className="sheet">
        <div className="sheet-head">Bills issued — current standing</div>
        <table className="statement">
          <thead>
            <tr>
              <th>Status</th>
              <th className="num">Bills</th>
              <th className="num">Outstanding balance</th>
            </tr>
          </thead>
          <tbody>
            {data.assessment_status_counts.map((r) => (
              <tr key={r.status}>
                <td>
                  <span className={`badge ${STATUS_TONE[r.status] ?? "badge-neutral"}`}>{r.status.replace(/_/g, " ")}</span>
                </td>
                <td className="num">{r.count}</td>
                <td className="num">{pkr(r.balance_total_minor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total still owed to {data.agency_code}</td>
              <td className="num">{data.assessment_status_counts.reduce((s, r) => s + r.count, 0)}</td>
              <td className="num">{pkr(outstanding)}</td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>
  );
}
