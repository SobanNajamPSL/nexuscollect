import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface RtpRow {
  id: string;
  rtp_reference: string;
  status: string;
  amount_minor: number;
  payer_name: string | null;
  expires_at: string;
  reminder_count: number;
  agency_code: string;
}

const ALIAS_TYPES = ["MSISDN", "EMAIL", "NATIONAL_ID", "FREE_TEXT"];

const ACTIONS_BY_STATUS: Record<string, { action: string; label: string }[]> = {
  CREATED: [{ action: "send", label: "Send" }],
  SENT: [{ action: "deliver", label: "Mark delivered" }, { action: "cancel", label: "Cancel" }],
  DELIVERED: [{ action: "present", label: "Mark presented" }, { action: "cancel", label: "Cancel" }],
  PRESENTED: [{ action: "accept", label: "Accept" }, { action: "decline", label: "Decline" }, { action: "cancel", label: "Cancel" }],
  EXPIRED: [{ action: "remind", label: "Send reminder" }],
};

export default function RequestToPay() {
  const [rows, setRows] = useState<RtpRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [psid, setPsid] = useState("");
  const [aliasType, setAliasType] = useState("MSISDN");
  const [aliasValue, setAliasValue] = useState("");
  const [payerName, setPayerName] = useState("");

  async function refresh() {
    try {
      setRows(await api.get<RtpRow[]>("/internal/rtp"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function createRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/internal/rtp", { psid, payer_alias_type: aliasType, payer_alias_value: aliasValue, ...(payerName ? { payer_name: payerName } : {}) });
      setPsid(""); setAliasValue(""); setPayerName(""); setShowCreate(false);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function act(id: string, action: string) {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/internal/rtp/${id}/transition`, { action, reason_code: action === "decline" ? "PAYER_DECLINED" : undefined });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gov-primaryDark">Request to Pay</h1>
          <p className="text-sm text-gov-ink/70 mt-1">Ask, instead of waiting — send a payer a request against an open bill, alias-addressed (§9.2's full lifecycle).</p>
        </div>
        <button className="btn" onClick={() => setShowCreate((s) => !s)}>{showCreate ? "Cancel" : "New request"}</button>
      </div>

      {showCreate && (
        <form onSubmit={createRequest} className="card p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input className="input" value={psid} onChange={(e) => setPsid(e.target.value)} placeholder="PSID of the open bill" required />
          <select className="input" value={aliasType} onChange={(e) => setAliasType(e.target.value)}>
            {ALIAS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="input" value={aliasValue} onChange={(e) => setAliasValue(e.target.value)} placeholder="Alias value (e.g. +923001234567)" required />
          <input className="input" value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="Payer name (optional)" />
          <button className="btn sm:col-span-4" type="submit">Create request</button>
        </form>
      )}

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      <div className="card divide-y divide-gov-border">
        {rows.map((r) => (
          <div key={r.id} className="p-3 flex items-center justify-between">
            <div>
              <div className="font-medium">{r.rtp_reference} <span className="text-xs text-gov-ink/60">({r.agency_code})</span></div>
              <div className="text-xs text-gov-ink/60">{r.payer_name ?? "unnamed payer"} · expires {new Date(r.expires_at).toLocaleDateString()} · {r.reminder_count} reminder(s)</div>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-right">
                <div className="font-medium">PKR {formatPKR(r.amount_minor)}</div>
                <span className="badge bg-gray-100 text-gray-700 text-xs">{r.status}</span>
              </div>
              <div className="flex gap-1">
                {(ACTIONS_BY_STATUS[r.status] ?? []).map((a) => (
                  <button key={a.action} disabled={busy === r.id} className="btn-secondary text-xs" onClick={() => act(r.id, a.action)}>{a.label}</button>
                ))}
              </div>
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-sm text-gov-ink/60">No requests to pay yet.</div>}
      </div>
    </div>
  );
}
