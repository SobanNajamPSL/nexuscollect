import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { Empty, PageHead, Status } from "../ui.js";

interface Row {
  psid: string;
  version: number;
  status: string;
  description: string;
  external_ref: string | null;
  product_code: string;
  payer_name: string | null;
  assessed_amount_minor: number;
  payable_amount_minor: number;
  allocated_amount_minor: number;
  balance_minor: number;
  issue_date: string;
  due_date: string;
}

interface Page {
  total: number;
  total_balance_minor: number;
  limit: number;
  offset: number;
  rows: Row[];
}

const STATUSES = ["ISSUED", "PARTIALLY_PAID", "OVERDUE", "SETTLED", "EXPIRED", "CANCELLED", "WRITTEN_OFF"];
const PAGE = 25;

export default function BillsIssued(): JSX.Element {
  const { current } = usePersona();
  const agency = current?.agency_code;

  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agency) return;
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (status) params.set("status", status);
    if (submittedQ) params.set("q", submittedQ);
    try {
      setPage(await api.get<Page>(`/internal/agency/${agency}/assessments?${params.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agency, status, submittedQ, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const showing = page ? `${page.total === 0 ? 0 : page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total}` : "…";

  return (
    <div>
      <PageHead
        title="Bills issued"
        right={<span className="text-xs text-ag-inkDim">{showing}</span>}
        note="Every assessment this agency has raised, at its current version. A bill that has been amended appears once, with the figures that now apply — the superseded version is kept in the record but not listed here."
      />

      <form
        className="sheet p-3 mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setSubmittedQ(q);
        }}
      >
        <div className="flex-1 min-w-[16rem]">
          <label className="label" htmlFor="q">
            Search
          </label>
          <input
            id="q"
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="PSID, payer name, our reference, or description"
          />
        </div>
        <div className="w-56">
          <label className="label" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            className="select"
            value={status}
            onChange={(e) => {
              setOffset(0);
              setStatus(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          Search
        </button>
        {(submittedQ || status) && (
          <button
            className="btn-secondary"
            type="button"
            onClick={() => {
              setQ("");
              setSubmittedQ("");
              setStatus("");
              setOffset(0);
            }}
          >
            Clear
          </button>
        )}
      </form>

      {error && <div className="sheet p-3 mb-4 border-ag-bad/40 bg-ag-bad/[0.04] text-ag-bad text-sm">{error}</div>}

      <div className="sheet overflow-x-auto">
        <table className="statement">
          <thead>
            <tr>
              <th>PSID</th>
              <th>Payer</th>
              <th>Product</th>
              <th>Due</th>
              <th>Status</th>
              <th className="num">Payable</th>
              <th className="num">Paid</th>
              <th className="num">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {page?.rows.map((r) => (
              <tr key={r.psid}>
                <td>
                  <Link className="font-mono text-[13px] text-ag-primary hover:underline" to={`/assessments/${r.psid}`}>
                    {r.psid}
                  </Link>
                  {r.version > 1 && <span className="ml-1.5 text-[10px] text-ag-inkDim">v{r.version}</span>}
                  {r.external_ref && <div className="text-[11px] text-ag-inkDim">{r.external_ref}</div>}
                </td>
                <td>{r.payer_name ?? <span className="text-ag-inkDim">—</span>}</td>
                <td className="text-[12px]">{r.product_code}</td>
                <td className="text-[12px] tabular-nums">{r.due_date}</td>
                <td>
                  <Status value={r.status} />
                </td>
                <td className="num">{pkr(r.payable_amount_minor)}</td>
                <td className="num">{pkr(r.allocated_amount_minor)}</td>
                <td className={`num ${r.balance_minor > 0 ? "font-semibold" : "text-ag-inkDim"}`}>
                  {pkr(r.balance_minor)}
                </td>
              </tr>
            ))}
            {page && page.rows.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <Empty>No bills match this filter.</Empty>
                </td>
              </tr>
            )}
          </tbody>
          {page && page.rows.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={7}>Outstanding across all {page.total} matching bills</td>
                <td className="num">{pkr(page.total_balance_minor)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {page && page.total > page.limit && (
        <div className="flex items-center justify-between mt-3 text-sm">
          <button className="btn-secondary btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <span className="text-ag-inkDim text-xs">{showing}</span>
          <button
            className="btn-secondary btn-sm"
            disabled={offset + PAGE >= page.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
