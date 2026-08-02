import { useState } from "react";
import { api } from "@shared/api.js";
import { Empty, Notice, PageHead } from "../ui.js";

interface AuditRow {
  id: number;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  occurred_at: string;
}

export default function Audit(): JSX.Element {
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [chain, setChain] = useState<{ intact: boolean; break: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    setError(null);
    try {
      const params = new URLSearchParams();
      if (entityType) params.set("entity_type", entityType);
      if (entityId) params.set("entity_id", entityId);
      setRows(await api.get<AuditRow[]>(`/internal/audit?${params.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function verify(): Promise<void> {
    setError(null);
    try {
      setChain(await api.get<{ intact: boolean; break: unknown }>("/internal/audit/verify-chain"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <PageHead
        title="Audit trail"
        right={
          <button className="btn" onClick={verify}>
            Verify chain
          </button>
        }
        note="Who did what, and when — on its own hash chain, separate from the ledger's. The ledger's chain proves the money wasn't quietly rewritten; this one proves the record of human and system actions wasn't either."
      />

      {error && <Notice tone="bad">{error}</Notice>}
      {chain && (
        <Notice tone={chain.intact ? "good" : "bad"}>
          {chain.intact ? "Audit chain intact from genesis." : `Tampering detected: ${JSON.stringify(chain.break)}`}
        </Notice>
      )}

      <form className="panel p-3 mb-3 flex flex-wrap items-end gap-3" onSubmit={search}>
        <div className="w-64">
          <label className="label" htmlFor="et">
            Entity type
          </label>
          <input id="et" className="input" placeholder="recon_break, refund, assessment…" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
        </div>
        <div className="w-72">
          <label className="label" htmlFor="ei">
            Entity id (optional)
          </label>
          <input id="ei" className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
        </div>
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <div className="panel">
        <div className="panel-head">Entries{rows ? ` — ${rows.length}` : ""}</div>
        {rows === null ? (
          <Empty>Search above, or verify the chain.</Empty>
        ) : rows.length === 0 ? (
          <Empty>No entries match.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th style={{ width: "16rem" }}>Action</th>
                <th>Entity</th>
                <th>Actor</th>
                <th style={{ width: "12rem" }}>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-semibold">{r.action}</td>
                  <td>
                    <span className="text-op-inkDim">{r.entity_type}</span>{" "}
                    {r.entity_id && <span className="ref">{r.entity_id.slice(0, 8)}…</span>}
                  </td>
                  <td>
                    <span className="badge badge-neutral">{r.actor_type}</span>{" "}
                    <span className="ref">{r.actor_id.length > 20 ? `${r.actor_id.slice(0, 8)}…` : r.actor_id}</span>
                  </td>
                  <td className="text-[11px] text-op-inkDim">{new Date(r.occurred_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
