import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Agency { code: string; name: string; tier: string; settlement_model: string; sweep_schedule: string; status: string }
interface ProductRow { agency_code: string; code: string; category: string; status: string; overpay_treatment: string; allocation_waterfall: string }

export default function AgencyConfig() {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Agency[]>("/internal/agencies").then(setAgencies).catch((e) => setError(e.message));
  }, []);

  async function selectAgency(code: string) {
    setSelected(code);
    setError(null);
    try {
      setProducts(await api.get<ProductRow[]>(`/internal/products?agency_code=${code}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gov-primaryDark">Agency &amp; product configuration</h1>
        <p className="text-sm text-gov-ink/70 mt-1">Real onboarded agencies and their configured collection products.</p>
      </div>
      {error && <div className="card p-4 border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      <div className="card divide-y divide-gov-border">
        {agencies.map((a) => (
          <button key={a.code} className={`w-full text-left p-3 hover:bg-gray-50 ${selected === a.code ? "bg-gray-50" : ""}`} onClick={() => selectAgency(a.code)}>
            <div className="flex items-center justify-between">
              <div><span className="font-medium">{a.code}</span> — {a.name}</div>
              <span className="badge bg-gray-100 text-gray-700 text-xs">{a.tier}</span>
            </div>
            <div className="text-xs text-gov-ink/60">{a.settlement_model} — sweep {a.sweep_schedule} — {a.status}</div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="card">
          <div className="p-3 font-semibold bg-gray-50">{selected} products</div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gov-ink/60 border-b border-gov-border"><th className="p-3">Code</th><th className="p-3">Category</th><th className="p-3">Waterfall</th><th className="p-3">Overpay treatment</th><th className="p-3">Status</th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.code} className="border-b border-gov-border last:border-0">
                  <td className="p-3">{p.code}</td><td className="p-3">{p.category}</td><td className="p-3">{p.allocation_waterfall}</td>
                  <td className="p-3">{p.overpay_treatment}</td><td className="p-3">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
