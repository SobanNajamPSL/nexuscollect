import { useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Notice, PageHead } from "../ui.js";

interface Exec {
  collectionsTrend: { valueDate: string; count: number; grossMinor: number }[];
  channelMix: { byChannel: { channel: string; status: string; count: number; valueMinor: number }[]; disclosedGap: string };
  autoResolution: { totalBreaks: number; autoResolvedBreaks: number; rate: number | null; disclosedGap: string };
  agencyCount: number;
  disclosedGaps: string[];
}

export default function Overview(): JSX.Element {
  const [d, setD] = useState<Exec | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Exec>("/internal/executive/overview").then(setD).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!d) return <div className="text-op-inkDim">Loading…</div>;

  const maxGross = Math.max(1, ...d.collectionsTrend.map((t) => t.grossMinor));
  const confirmed = Object.entries(
    d.channelMix.byChannel.filter((c) => c.status === "CONFIRMED").reduce<Record<string, number>>((acc, c) => {
      acc[c.channel] = (acc[c.channel] ?? 0) + c.valueMinor;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  const maxChannel = Math.max(1, ...confirmed.map(([, v]) => v));

  return (
    <div>
      <PageHead title="Platform overview" note="Across every agency. Each figure is a live query; where the platform genuinely doesn't track something, it says so rather than approximating." />

      <div className="grid grid-cols-4 gap-2 mb-4">
        <div className="metric"><div className="metric-label">Agencies</div><div className="metric-value">{d.agencyCount}</div></div>
        <div className="metric">
          <div className="metric-label">Breaks auto-resolved</div>
          <div className="metric-value">{d.autoResolution.autoResolvedBreaks}/{d.autoResolution.totalBreaks}</div>
          <div className="text-[10px] text-op-inkDim mt-0.5">{d.autoResolution.rate !== null ? `${(d.autoResolution.rate * 100).toFixed(0)}%` : "—"}</div>
        </div>
        <div className="metric"><div className="metric-label">Business days of data</div><div className="metric-value">{d.collectionsTrend.length}</div></div>
        <div className="metric">
          <div className="metric-label">Channels in use</div>
          <div className="metric-value">{confirmed.length}</div>
        </div>
      </div>

      <section className="panel mb-3">
        <div className="panel-head">Collections trend — gross confirmed inbound, per business date</div>
        <div className="p-3">
          <div className="flex items-end gap-2 h-28">
            {d.collectionsTrend.map((t) => (
              <div key={t.valueDate} className="flex flex-col items-center justify-end gap-1 flex-1 h-full">
                <div className="w-full bg-op-primary/70 rounded-t" style={{ height: `${Math.max(3, (t.grossMinor / maxGross) * 100)}%` }} title={pkr(t.grossMinor)} />
                <div className="text-[10px] text-op-inkDim">{t.valueDate.slice(5)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel mb-3">
        <div className="panel-head">Channel mix — confirmed value</div>
        <table className="grid-table">
          <thead><tr><th style={{ width: "8rem" }}>Channel</th><th>Share</th><th className="num" style={{ width: "10rem" }}>Value</th></tr></thead>
          <tbody>
            {confirmed.map(([channel, value]) => (
              <tr key={channel}>
                <td className="font-semibold">{channel}</td>
                <td>
                  <div className="bg-op-rule/40 rounded h-3 w-full max-w-md overflow-hidden">
                    <div className="bg-op-primary h-3" style={{ width: `${(value / maxChannel) * 100}%` }} />
                  </div>
                </td>
                <td className="num">{pkr(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel border-op-warn/40 bg-op-warn/[0.03]">
        <div className="panel-head text-op-warn">Not tracked — stated rather than estimated</div>
        <ul className="px-4 py-3 list-disc list-inside text-op-inkDim space-y-0.5">
          {d.disclosedGaps.map((g) => <li key={g}>{g}</li>)}
          <li>{d.channelMix.disclosedGap}</li>
          <li>{d.autoResolution.disclosedGap}</li>
        </ul>
      </section>
    </div>
  );
}
