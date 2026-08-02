import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Approval {
  id: string; subject_type: string; action: string; amount_minor: number | null; state: string;
  maker_user_id: string; maker_at: string;
  refund_preview: { refund_reference: string; mode: string; payment_reference: string } | null;
}

export default function Approvals(): JSX.Element {
  const [rows, setRows] = useState<Approval[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState("PENDING");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, u] = await Promise.all([
        api.get<Approval[]>(`/internal/approvals?state=${state}`),
        api.get<{ id: string; name: string }[]>("/internal/users"),
      ]);
      setRows(a);
      setNames(Object.fromEntries(u.map((x) => [x.id, x.name.replace(/\s*\(.*\)$/, "")])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [state]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <PageHead
        title="Approvals inbox"
        right={
          <select className="select w-40" value={state} onChange={(e) => setState(e.target.value)}>
            {["PENDING", "APPROVED", "REJECTED"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        }
        note="Everything that needed a second pair of eyes, in one queue — break resolutions, refunds and product configuration. The maker and the checker can never be the same person, and the database enforces that rather than the screen."
      />

      {error && <Notice tone="bad">{error}</Notice>}

      <div className="panel">
        <div className="panel-head">{state} — {rows.length}</div>
        {rows.length === 0 ? <Empty>Nothing {state.toLowerCase()}.</Empty> : (
          <table className="grid-table">
            <thead>
              <tr><th>Action</th><th>Subject</th><th>Proposed by</th><th>When</th><th className="num">Amount</th><th>State</th></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="font-semibold">{a.action.replace(/_/g, " ")}</td>
                  <td>
                    <span className="text-op-inkDim">{a.subject_type.replace(/_/g, " ")}</span>
                    {a.refund_preview && (
                      <div className="text-[11px] text-op-inkDim">
                        <span className="ref">{a.refund_preview.refund_reference}</span> ({a.refund_preview.mode.replace(/_/g, " ").toLowerCase()}) against{" "}
                        <span className="ref">{a.refund_preview.payment_reference}</span>
                      </div>
                    )}
                  </td>
                  <td>{names[a.maker_user_id] ?? <span className="ref">{a.maker_user_id.slice(0, 8)}…</span>}</td>
                  <td className="text-[11px] text-op-inkDim">{new Date(a.maker_at).toLocaleString()}</td>
                  <td className="num">{a.amount_minor !== null ? pkr(a.amount_minor) : "—"}</td>
                  <td><Status value={a.state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
