import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@shared/api.js";
import { pkr, toMinor } from "@shared/money.js";
import { usePersona } from "@shared/PersonaContext.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";
import { Notice, PageHead } from "../ui.js";

interface Product {
  id: string;
  code: string;
  category: string;
  status: string;
}
interface RevenueHead {
  id: string;
  code: string;
  name: string;
}

const LINE_TYPES = ["PRINCIPAL", "SURCHARGE", "PENALTY", "INTEREST", "FEE", "ARREAR"];

interface LineDraft {
  key: number;
  lineType: string;
  headCode: string;
  amountPkr: string;
  description: string;
}

let nextKey = 1;
const emptyLine = (lineType = "PRINCIPAL"): LineDraft => ({
  key: nextKey++,
  lineType,
  headCode: "",
  amountPkr: "",
  description: "",
});

export default function IssueBill(): JSX.Element {
  const { current } = usePersona();
  const agency = current?.agency_code;
  const clock = useDemoClock();
  const today = businessDate(clock);

  const [products, setProducts] = useState<Product[]>([]);
  const [heads, setHeads] = useState<RevenueHead[]>([]);
  const [productCode, setProductCode] = useState("");
  const [payerName, setPayerName] = useState("");
  const [payerIdValue, setPayerIdValue] = useState("");
  const [payerType, setPayerType] = useState("INDIVIDUAL");
  const [description, setDescription] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ psid: string } | null>(null);

  useEffect(() => {
    if (!agency) return;
    void api
      .get<Product[]>(`/internal/products?agency_code=${agency}`)
      .then((p) => setProducts(p.filter((x) => x.status === "ACTIVE")))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void api
      .get<RevenueHead[]>(`/internal/revenue-heads?agency_code=${agency}`)
      .then(setHeads)
      .catch(() => undefined);
  }, [agency]);

  useEffect(() => {
    if (today && !dueDate) setDueDate(today);
  }, [today, dueDate]);

  const totalMinor = lines.reduce((s, l) => s + (l.amountPkr ? toMinor(l.amountPkr) : 0), 0);
  const canSubmit =
    productCode !== "" &&
    payerName.trim() !== "" &&
    payerIdValue.trim() !== "" &&
    dueDate !== "" &&
    lines.length > 0 &&
    lines.every((l) => l.headCode !== "" && l.amountPkr !== "" && toMinor(l.amountPkr) > 0);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!today) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await api.post<{ psid: string }>("/v1/agency/assessments", {
        product_code: productCode,
        external_ref: externalRef || undefined,
        payer: {
          payer_type: payerType,
          primary_id_type: payerType === "COMPANY" || payerType === "AOP" ? "NTN" : "CNIC",
          primary_id_value: payerIdValue.trim(),
          name: payerName.trim(),
        },
        description,
        assessed_amount_minor: totalMinor,
        issue_date: today,
        due_date: dueDate,
        line_items: lines.map((l, i) => ({
          seq: i + 1,
          line_type: l.lineType,
          revenue_head_code: l.headCode,
          amount_minor: toMinor(l.amountPkr),
          description: l.description || undefined,
          allocation_priority: 100,
        })),
      });
      setCreated({ psid: res.psid });
      setLines([emptyLine()]);
      setPayerName("");
      setPayerIdValue("");
      setDescription("");
      setExternalRef("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHead
        title="Issue a bill"
        note="Raise a new assessment against one of this agency's products. Line items are head-wise and must sum to the assessed amount — that is what lets a single payment be split deterministically across revenue heads, and the database refuses the bill outright if they don't tie."
      />

      {created && (
        <div className="mb-4">
          <Notice tone="good">
            Bill issued as PSID{" "}
            <Link className="font-mono font-semibold underline" to={`/assessments/${created.psid}`}>
              {created.psid}
            </Link>
            . The check digit is computed by the platform, so a mistyped reference is rejected before any lookup happens.
          </Notice>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}

      <form onSubmit={submit} className="space-y-5 max-w-4xl">
        <section className="sheet">
          <div className="sheet-head">Who and what</div>
          <div className="p-4 grid grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="product">
                Product
              </label>
              <select id="product" className="select" value={productCode} onChange={(e) => setProductCode(e.target.value)} required>
                <option value="">Select a product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.code}>
                    {p.code} — {p.category}
                  </option>
                ))}
              </select>
              {products.length === 0 && (
                <p className="text-[11px] text-ag-inkDim mt-1">No active products. Configure one under Products first.</p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="external-ref">
                Your own reference <span className="font-normal normal-case">(optional)</span>
              </label>
              <input
                id="external-ref"
                className="input"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                placeholder="e.g. DEMAND/IT/2026/4100"
              />
            </div>

            <div>
              <label className="label" htmlFor="payer-type">
                Payer type
              </label>
              <select id="payer-type" className="select" value={payerType} onChange={(e) => setPayerType(e.target.value)}>
                {["INDIVIDUAL", "SOLE_PROPRIETOR", "AOP", "COMPANY", "GOVERNMENT", "NON_RESIDENT"].map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="payer-name">
                Payer name
              </label>
              <input id="payer-name" className="input" value={payerName} onChange={(e) => setPayerName(e.target.value)} required />
            </div>

            <div>
              <label className="label" htmlFor="payer-id">
                {payerType === "COMPANY" || payerType === "AOP" ? "NTN" : "CNIC"}
              </label>
              <input
                id="payer-id"
                className="input"
                value={payerIdValue}
                onChange={(e) => setPayerIdValue(e.target.value)}
                required
              />
              <p className="text-[11px] text-ag-inkDim mt-1">
                Stored encrypted and hashed; only the last four digits are ever displayed back.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="due">
                Due date
              </label>
              <input id="due" className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
              <p className="text-[11px] text-ag-inkDim mt-1">Issued today, {today ?? "…"} (business date).</p>
            </div>

            <div className="col-span-2">
              <label className="label" htmlFor="desc">
                Description
              </label>
              <input
                id="desc"
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this bill is for, as the payer will see it"
              />
            </div>
          </div>
        </section>

        <section className="sheet">
          <div className="sheet-head">Head-wise line items</div>
          <table className="statement">
            <thead>
              <tr>
                <th style={{ width: "9rem" }}>Type</th>
                <th>Revenue head</th>
                <th>Description</th>
                <th className="num" style={{ width: "10rem" }}>
                  Amount (PKR)
                </th>
                <th style={{ width: "3rem" }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={l.key}>
                  <td>
                    <select
                      className="select"
                      value={l.lineType}
                      onChange={(e) =>
                        setLines(lines.map((x) => (x.key === l.key ? { ...x, lineType: e.target.value } : x)))
                      }
                      aria-label={`Line ${idx + 1} type`}
                    >
                      {LINE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="select"
                      value={l.headCode}
                      onChange={(e) =>
                        setLines(lines.map((x) => (x.key === l.key ? { ...x, headCode: e.target.value } : x)))
                      }
                      aria-label={`Line ${idx + 1} revenue head`}
                      required
                    >
                      <option value="">Select…</option>
                      {heads.map((h) => (
                        <option key={h.id} value={h.code}>
                          {h.code} — {h.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input"
                      value={l.description}
                      onChange={(e) =>
                        setLines(lines.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))
                      }
                      aria-label={`Line ${idx + 1} description`}
                    />
                  </td>
                  <td>
                    <input
                      className="input text-right tabular-nums"
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={l.amountPkr}
                      onChange={(e) =>
                        setLines(lines.map((x) => (x.key === l.key ? { ...x, amountPkr: e.target.value } : x)))
                      }
                      aria-label={`Line ${idx + 1} amount`}
                      required
                    />
                  </td>
                  <td>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        className="text-ag-bad text-lg leading-none px-1"
                        onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
                        aria-label={`Remove line ${idx + 1}`}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Assessed amount</td>
                <td className="num">{pkr(totalMinor)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          <div className="px-4 py-2.5 border-t border-ag-rule">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setLines([...lines, emptyLine()])}>
              + Add a line
            </button>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <button className="btn" type="submit" disabled={busy || !canSubmit}>
            {busy ? "Issuing…" : "Issue bill"}
          </button>
          <span className="text-[12px] text-ag-inkDim">
            {canSubmit ? `Will be issued for ${pkr(totalMinor)}.` : "Complete the payer, product, due date and at least one line item."}
          </span>
        </div>
      </form>
    </div>
  );
}
