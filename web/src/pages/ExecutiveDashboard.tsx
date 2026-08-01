import { useEffect, useState } from "react";
import { api, formatPKR } from "../lib/api.js";

interface ExecutiveOverview {
  collectionsTrend: { valueDate: string; count: number; grossMinor: number }[];
  channelMix: { byChannel: { channel: string; status: string; count: number; valueMinor: number }[]; disclosedGap: string };
  autoResolution: { totalBreaks: number; autoResolvedBreaks: number; rate: number | null; disclosedGap: string };
  agencyCount: number;
  disclosedGaps: string[];
}

export default function ExecutiveDashboard() {
  const [overview, setOverview] = useState<ExecutiveOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<ExecutiveOverview>("/internal/executive/overview").then(setOverview).catch((e) => setError((e as Error).message));
  }, []);

  const maxGross = overview ? Math.max(1, ...overview.collectionsTrend.map((t) => t.grossMinor)) : 1;

  // Aggregate CONFIRMED value across channels for a simple mix view.
  const channelTotals = overview
    ? Object.entries(
        overview.channelMix.byChannel.filter((c) => c.status === "CONFIRMED").reduce<Record<string, number>>((acc, c) => {
          acc[c.channel] = (acc[c.channel] ?? 0) + c.valueMinor;
          return acc;
        }, {}),
      )
    : [];
  const maxChannel = channelTotals.length > 0 ? Math.max(...channelTotals.map(([, v]) => v)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Executive Dashboard</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Collections trend, channel mix, reconciliation auto-resolution rate, and agency count — every figure drawn from real data, with gaps disclosed rather than approximated.</p>
      </div>

      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {overview && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="card p-4">
              <div className="text-xs text-gov-ink/60">Agencies onboarded</div>
              <div className="text-3xl font-bold">{overview.agencyCount}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs text-gov-ink/60">Recon breaks auto-resolved</div>
              <div className="text-3xl font-bold">{overview.autoResolution.autoResolvedBreaks} / {overview.autoResolution.totalBreaks}</div>
              <div className="text-xs text-gov-ink/50 mt-1">{overview.autoResolution.rate !== null ? `${(overview.autoResolution.rate * 100).toFixed(0)}%` : "—"}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs text-gov-ink/60">Days of collection data</div>
              <div className="text-3xl font-bold">{overview.collectionsTrend.length}</div>
            </div>
          </div>

          <div className="card p-4">
            <div className="font-semibold text-sm mb-3">Collections trend (gross confirmed inbound, per business date)</div>
            <div className="flex items-end gap-3 h-32">
              {overview.collectionsTrend.map((t) => (
                <div key={t.valueDate} className="flex flex-col items-center justify-end gap-1 flex-1 h-full">
                  <div className="w-full bg-gov-primary/70 rounded-t" style={{ height: `${Math.max(4, (t.grossMinor / maxGross) * 100)}%` }} title={`PKR ${formatPKR(t.grossMinor)}`} />
                  <div className="text-[10px] text-gov-ink/60 whitespace-nowrap">{t.valueDate.slice(5)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <div className="font-semibold text-sm mb-3">Channel mix (confirmed value)</div>
            <div className="space-y-2">
              {channelTotals.map(([channel, value]) => (
                <div key={channel} className="flex items-center gap-2 text-sm">
                  <div className="w-24 text-xs text-gov-ink/70">{channel}</div>
                  <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden"><div className="bg-gov-primary h-4" style={{ width: `${(value / maxChannel) * 100}%` }} /></div>
                  <div className="w-28 text-right text-xs">PKR {formatPKR(value)}</div>
                </div>
              ))}
            </div>
            <div className="text-xs text-gov-ink/50 mt-3">{overview.channelMix.disclosedGap}</div>
          </div>

          <div className="card p-4 border-amber-300 bg-amber-50">
            <div className="font-semibold text-sm mb-1">Known gaps (disclosed, not approximated)</div>
            <ul className="list-disc list-inside text-xs text-gov-ink/70 space-y-0.5">
              {overview.disclosedGaps.map((g) => <li key={g}>{g}</li>)}
              <li>{overview.autoResolution.disclosedGap}</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
