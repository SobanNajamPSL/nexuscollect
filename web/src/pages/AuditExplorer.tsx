import { useState } from "react";
import { api } from "../lib/api.js";

interface AuditRow { id: number; actor_type: string; actor_id: string; action: string; entity_type: string; entity_id: string | null; occurred_at: string }
interface ChainStatus { intact: boolean; break: { entryNo?: number; reason?: string } | null }

export default function AuditExplorer() {
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (entityType) params.set("entity_type", entityType);
      if (entityId) params.set("entity_id", entityId);
      setRows(await api.get<AuditRow[]>(`/internal/audit?${params.toString()}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function verifyChain() {
    setError(null);
    try {
      setChain(await api.get<ChainStatus>("/internal/audit/verify-chain"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gov-primaryDark">Audit explorer</h1>
          <p className="text-sm text-gov-ink/70 mt-1">Search the audit log; verify the hash chain is intact from genesis.</p>
        </div>
        <button className="btn" onClick={verifyChain}>Verify chain</button>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}
      {chain && (
        <div className={`card p-4 ${chain.intact ? "bg-green-50 border-green-300" : "bg-red-50 border-red-300"}`}>
          {chain.intact ? "Audit chain intact from genesis." : `Break detected: ${JSON.stringify(chain.break)}`}
        </div>
      )}

      <div className="flex gap-2">
        <input className="input" placeholder="Entity type (e.g. refund, assessment)" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
        <input className="input" placeholder="Entity id (optional)" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
        <button className="btn" onClick={search}>Search</button>
      </div>

      <div className="card divide-y divide-gov-border">
        {rows.map((r) => (
          <div key={r.id} className="p-3 text-sm flex justify-between">
            <div>
              <div className="font-medium">{r.action}</div>
              <div className="text-xs text-gov-ink/60">{r.entity_type} {r.entity_id ? `#${r.entity_id.slice(0, 8)}` : ""} — {r.actor_type}:{r.actor_id}</div>
            </div>
            <div className="text-xs text-gov-ink/60">{new Date(r.occurred_at).toLocaleString()}</div>
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-sm text-gov-ink/60">No results — search above.</div>}
      </div>
    </div>
  );
}
