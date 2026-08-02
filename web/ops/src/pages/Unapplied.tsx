import { useEffect, useState } from "react";
import { api } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { Empty, Notice, PageHead } from "../ui.js";

interface Row {
  payment_reference: string;
  amount_minor: number;
  value_date: string;
  channel: string;
  rail: string;
  remittance_raw: string | null;
}

export default function Unapplied(): JSX.Element {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Row[]>("/internal/unapplied-receipts")
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const total = rows.reduce((s, r) => s + r.amount_minor, 0);

  return (
    <div>
      <PageHead
        title="Unapplied receipts"
        right={<span className="text-op-inkDim">{pkr(total)} unmatched</span>}
        note="Money the platform has definitely received but cannot yet attribute to a bill — usually because the remittance narrative didn't identify one. It is held here and fully accounted for in the ledger rather than rejected: refusing a credit that has already left the payer's account is the most expensive mistake in this domain."
      />

      {error && <Notice tone="bad">{error}</Notice>}

      <div className="panel">
        <div className="panel-head">Stranded money — {rows.length}</div>
        {rows.length === 0 ? (
          <Empty>Nothing unapplied.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Payment</th>
                <th>Channel / rail</th>
                <th>Value date</th>
                <th>Remittance narrative as received</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.payment_reference}-${i}`}>
                  <td className="ref font-semibold">{r.payment_reference}</td>
                  <td>
                    {r.channel} / {r.rail}
                  </td>
                  <td className="tabular-nums">{r.value_date}</td>
                  <td className="text-[11px] text-op-inkDim italic">
                    {r.remittance_raw ? `“${r.remittance_raw}”` : "— none supplied —"}
                  </td>
                  <td className="num">{pkr(r.amount_minor)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="font-semibold px-2.5 py-1.5 border-t border-op-rule">
                  Total held
                </td>
                <td className="num font-semibold border-t border-op-rule">{pkr(total)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
