import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { Empty, Notice, PageHead, Status } from "../ui.js";

interface Rtp {
  id: string;
  rtp_reference: string;
  status: string;
  amount_minor: number;
  payer_name: string | null;
  expires_at: string;
  reminder_count: number;
  agency_code: string;
}

/**
 * §9.2's lifecycle, as the actions actually available at each state. Offering
 * every transition at every state would misrepresent the state machine — the
 * platform rejects an illegal transition, and the UI shouldn't invite one.
 */
const ACTIONS: Record<string, { action: string; label: string }[]> = {
  CREATED: [
    { action: "send", label: "Send" },
    { action: "cancel", label: "Cancel" },
  ],
  SENT: [
    { action: "deliver", label: "Mark delivered" },
    { action: "cancel", label: "Cancel" },
  ],
  DELIVERED: [
    { action: "present", label: "Mark presented" },
    { action: "remind", label: "Remind" },
    { action: "cancel", label: "Cancel" },
  ],
  PRESENTED: [
    { action: "accept", label: "Payer accepts" },
    { action: "decline", label: "Payer declines" },
    { action: "cancel", label: "Cancel" },
  ],
};

export default function RequestToPay(): JSX.Element {
  const { current } = usePersona();
  const agency = current?.agency_code;

  const [rows, setRows] = useState<Rtp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await api.get<Rtp[]>("/internal/rtp");
      // The agency portal only ever shows this agency's own requests.
      setRows(all.filter((r) => r.agency_code === agency));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agency]);

  useEffect(() => {
    void load();
  }, [load]);

  async function transition(rtp: Rtp, action: string): Promise<void> {
    setBusy(rtp.id + action);
    setError(null);
    setDone(null);
    try {
      await api.post(`/internal/rtp/${rtp.id}/transition`, { action, actor_id: "agency-portal" });
      setDone(`${rtp.rtp_reference}: ${action}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <PageHead
        title="Request to pay"
        right={<span className="text-xs text-ag-inkDim">{rows.length} requests</span>}
        note="Ask a payer to settle an open bill instead of waiting for them to look it up. The request is addressed by alias — a phone number or similar — and carries its own lifecycle up to the point the payer accepts, at which stage payment runs through exactly the same pipeline as every other channel."
      />

      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {done && (
        <div className="mb-4">
          <Notice tone="good">{done}</Notice>
        </div>
      )}

      {Object.keys(byStatus).length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {Object.entries(byStatus)
            .sort((a, b) => b[1] - a[1])
            .map(([s, n]) => (
              <span key={s} className="text-[11px] border border-ag-rule rounded-sm px-2 py-1 bg-ag-panel">
                <span className="text-ag-inkDim">{s.replace(/_/g, " ")}</span>{" "}
                <span className="font-semibold tabular-nums">{n}</span>
              </span>
            ))}
        </div>
      )}

      <div className="sheet overflow-x-auto">
        <table className="statement">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Payer</th>
              <th className="num">Amount</th>
              <th>Expires</th>
              <th>Reminders</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const actions = ACTIONS[r.status] ?? [];
              return (
                <tr key={r.id}>
                  <td className="font-mono text-[13px]">{r.rtp_reference}</td>
                  <td>{r.payer_name ?? <span className="text-ag-inkDim">—</span>}</td>
                  <td className="num">{pkr(r.amount_minor)}</td>
                  <td className="text-[12px] tabular-nums">{r.expires_at.slice(0, 10)}</td>
                  <td className="tabular-nums text-[12px]">{r.reminder_count}</td>
                  <td>
                    <Status value={r.status} />
                  </td>
                  <td>
                    {actions.length === 0 ? (
                      <span className="text-ag-inkDim text-[12px]">Final</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {actions.map((a) => (
                          <button
                            key={a.action}
                            className="btn-secondary btn-sm"
                            disabled={busy !== null}
                            onClick={() => transition(r, a.action)}
                          >
                            {a.label}
                          </button>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <Empty>No requests to pay for this agency.</Empty>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
