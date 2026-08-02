import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "@shared/api.js";
import { pkr } from "@shared/money.js";
import { businessDate, useDemoClock } from "@shared/demoClock.js";

/**
 * Find and pay a bill.
 *
 * The one screen a member of the public ever uses. Everything about it follows
 * from the fact that there is no account: a bill is found by a reference the
 * payer already has in their hand, and the reference's own check digit is what
 * stops a typo from becoming a failed lookup against a live database.
 *
 * Two things here are load-bearing for the demonstration rather than for the
 * payer:
 *
 *   - One reference returns bills belonging to **two different agencies**, in
 *     one list, with one "pay" action. That is the whole argument for a shared
 *     collection platform, and it is why the results are grouped by agency
 *     instead of flattened.
 *   - A bill that has already been paid comes back with its **receipt attached**
 *     (§8.2), not as an error. Showing the payer the receipt they have forgotten
 *     about is what prevents the duplicate payment in the first place.
 */

/**
 * The API's key types are enum values; a payer sees the thing they are holding.
 * The examples are real references from the seeded dataset — the same ones the
 * agency and operator portals show — so a reviewer can follow one reference
 * across all four portals.
 */
const LOOKUPS = [
  { key: "VEHICLE_REG", label: "Vehicle registration", hint: "e.g. LEA-17-1000" },
  { key: "PSID", label: "Bill number (PSID)", hint: "17 digits, printed on the bill" },
  { key: "CNIC", label: "CNIC", hint: "13 digits, no dashes" },
  { key: "NTN", label: "NTN", hint: "National Tax Number" },
  { key: "CASE_NO", label: "Case number", hint: "e.g. CP-1123/2026" },
  { key: "APPLICATION_NO", label: "Application number", hint: "e.g. NAD-2026-8891200" },
  { key: "QR_PAYLOAD", label: "Scanned QR code", hint: "Paste what the scanner read" },
] as const;

interface Payable {
  psid: string;
  agency_code: string;
  agency_name: string;
  label: string;
  payable_amount_minor: number;
  status: string;
  due_date: string;
  discount_applied_minor: number;
  discount_expires_on: string | null;
  payer_name_masked: string | null;
}
interface Settled {
  psid: string;
  status: string;
  settled_on: string;
  receipt_no: string;
}
interface ResolveResponse {
  resolution_token: string | null;
  payables: Payable[];
  settled: Settled[];
}

/** Friendly, specific, and never blaming the payer for a platform word. */
function readableError(err: unknown): string {
  const e = err as ApiError;
  if (e.code === "INVALID_REFERENCE_CHECKSUM") {
    return "That reference doesn't look right — please check the digits and try again. (Nothing was looked up: the number failed its own check digit.)";
  }
  if (e.code === "REFERENCE_NOT_FOUND") return "We couldn't find any bill for that reference.";
  return e.message;
}

export default function FindBill(): JSX.Element {
  const navigate = useNavigate();
  const clockIso = useDemoClock();
  const today = businessDate(clockIso);

  const [lookup, setLookup] = useState<string>("VEHICLE_REG");
  const [value, setValue] = useState("LEA-17-1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [paying, setPaying] = useState(false);
  const [altFor, setAltFor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const active = LOOKUPS.find((l) => l.key === lookup)!;

  async function find(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    setResult(null);
    try {
      setResult(await api.post<ResolveResponse>("/v1/resolve", { key_type: lookup, key_value: value, channel: "APP" }, { idempotent: false }));
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * One tap, every bill, across every agency.
   *
   * The resolution token binds the amounts the payer was *shown* to the amounts
   * they are about to be charged, so a surcharge accruing between resolving and
   * paying cannot silently change the total (§8.2).
   *
   * One tap, but **one payment per agency** — because a payment belongs to
   * exactly one agency (§6.4) and is swept into exactly one treasury account. A
   * single payment spanning two agencies could never be settled or scrolled
   * correctly, so grouping here is what keeps the money provably attributable
   * all the way to treasury. The payer still sees one action and one total; they
   * receive one receipt per agency, which is what they would get at a counter
   * too.
   */
  async function payEverything(): Promise<void> {
    if (!result?.resolution_token || !today) return;
    setPaying(true);
    setError(null);
    try {
      const references: string[] = [];
      // Ordered by agency name so the same demonstration produces the same
      // receipts in the same order every time.
      for (const [, bills] of Object.entries(byAgency).sort(([a], [b]) => a.localeCompare(b))) {
        const intent = await api.post<{ intent_reference: string; total_debit_minor: number }>("/v1/payment-intents", {
          resolution_token: result.resolution_token,
          channel: "APP",
          psids: bills.map((b) => b.psid),
        });
        const payment = await api.post<{ payment_reference: string; status: string }>("/v1/payments", {
          intent_reference: intent.intent_reference,
          channel: "APP",
          rail: "RAAST",
          gross_amount_minor: intent.total_debit_minor,
          value_date: today,
          obligation_discharge_date: today,
          capture_outcome: "CONFIRMED",
        });
        references.push(payment.payment_reference);
      }
      navigate(references.length === 1 ? `/receipt/${references[0]}` : `/receipts?refs=${references.join(",")}`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setPaying(false);
    }
  }

  /**
   * Card and wallet, per bill.
   *
   * There is no card number field on this screen, and there is none anywhere in
   * the platform: a hosted field returns a token, and the token plus the first
   * six and last four digits is the whole of what is ever stored. That is not a
   * UI choice — it is what keeps the platform outside PCI scope, and the
   * confirmation below deliberately states exactly what was kept.
   */
  async function payOne(p: Payable, method: "card" | "wallet"): Promise<void> {
    if (!today) return;
    setError(null);
    setNote(null);
    try {
      if (method === "card") {
        const res = await api.post<{ payment_reference?: string; status: string }>("/internal/payments/card", {
          psid: p.psid,
          amount_minor: p.payable_amount_minor,
          value_date: today,
          gateway_token: `tok_${crypto.randomUUID().slice(0, 12)}`,
          bin6: "435671",
          last4: "4242",
          scheme: "PAYPAK",
        });
        setNote(`Card payment ${res.status.toLowerCase()}. Stored: the gateway token, BIN 435671 and last four 4242 — the card number itself never reached the platform.`);
      } else {
        const res = await api.post<{ payment_reference?: string; status: string }>("/internal/payments/wallet", {
          psid: p.psid,
          amount_minor: p.payable_amount_minor,
          value_date: today,
          wallet_provider: "EASYPAISA",
          wallet_msisdn_masked: "03**-***1234",
        });
        setNote(`Wallet payment ${res.status.toLowerCase()} via EasyPaisa, from 03**-***1234.`);
      }
      setAltFor(null);
    } catch (err) {
      setError(readableError(err));
    }
  }

  /** Grouped by agency, because one reference legitimately spans several. */
  const byAgency = (result?.payables ?? []).reduce<Record<string, Payable[]>>((acc, p) => {
    (acc[p.agency_name] ??= []).push(p);
    return acc;
  }, {});
  const total = (result?.payables ?? []).reduce((s, p) => s + p.payable_amount_minor, 0);
  const agencyCount = Object.keys(byAgency).length;

  return (
    <div className="space-y-5">
      <form onSubmit={find} className="space-y-3">
        <div>
          <label className="label" htmlFor="lookup">What do you have?</label>
          <select id="lookup" className="select" value={lookup} onChange={(e) => setLookup(e.target.value)}>
            {LOOKUPS.map((l) => (
              <option key={l.key} value={l.key}>{l.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ref">{active.label}</label>
          <input id="ref" className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={active.hint} autoComplete="off" />
          <div className="text-xs text-cz-inkDim mt-1.5">{active.hint}</div>
        </div>
        <button className="btn" type="submit" disabled={busy || value.trim() === ""}>
          {busy ? "Looking up…" : "Find my bills"}
        </button>
      </form>

      {error && <div className="card p-4 text-sm bg-red-50 border-red-200 text-red-800">{error}</div>}
      {note && <div className="card p-4 text-sm bg-emerald-50 border-emerald-200 text-emerald-900">{note}</div>}

      {result && result.payables.length === 0 && result.settled.length === 0 && (
        <div className="card p-4 text-sm text-cz-inkDim">
          Nothing is outstanding against that reference. If you were expecting a bill, check the reference on the notice you received.
        </div>
      )}

      {result && result.payables.length > 0 && (
        <div className="space-y-4">
          <div className="card p-4 bg-cz-primary/[0.04] border-cz-primary/20">
            <div className="text-sm text-cz-inkDim">
              {result.payables.length} bill{result.payables.length > 1 ? "s" : ""} outstanding
              {agencyCount > 1 && <> across {agencyCount} agencies</>}
            </div>
            <div className="text-2xl font-semibold text-cz-primary mt-1 tabular-nums">{pkr(total)}</div>
          </div>

          {Object.entries(byAgency).map(([agency, bills]) => (
            <section key={agency} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-cz-inkDim">{agency}</h3>
              {bills.map((p) => (
                <div key={p.psid} className="payable space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium leading-snug">{p.label}</div>
                      <div className="text-xs text-cz-inkDim mt-1">Bill {p.psid}</div>
                      <div className="text-xs text-cz-inkDim">Due {p.due_date}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="amount text-lg">{pkr(p.payable_amount_minor)}</div>
                      <span className={`badge mt-1 ${p.status === "OVERDUE" ? "badge-overdue" : "badge-due"}`}>
                        {p.status === "OVERDUE" ? "Overdue" : "Due"}
                      </span>
                    </div>
                  </div>

                  {p.discount_applied_minor > 0 && (
                    <div className="text-xs rounded-lg bg-emerald-50 text-emerald-900 px-3 py-2">
                      <strong>{pkr(p.discount_applied_minor)} early-payment discount</strong> is already applied above
                      {p.discount_expires_on && <> — pay by {p.discount_expires_on} to keep it</>}.
                    </div>
                  )}

                  <div>
                    <button type="button" className="text-xs text-cz-primary underline underline-offset-2" onClick={() => setAltFor(altFor === p.psid ? null : p.psid)}>
                      Pay this one on its own
                    </button>
                    {altFor === p.psid && (
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <button type="button" className="btn-secondary btn-inline" onClick={() => void payOne(p, "card")}>Card</button>
                        <button type="button" className="btn-secondary btn-inline" onClick={() => void payOne(p, "wallet")}>Wallet</button>
                        <a className="btn-secondary btn-inline" href={`/v1/challan/${p.psid}`} target="_blank" rel="noreferrer">Challan</a>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </section>
          ))}

          <button className="btn" onClick={() => void payEverything()} disabled={paying || !today}>
            {paying ? "Paying…" : `Pay all ${result.payables.length} bills — ${pkr(total)}`}
          </button>
          <p className="text-xs text-cz-inkDim text-center">
            One transfer settles every bill above, whichever agency issued it.
          </p>
        </div>
      )}

      {result && result.settled.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-cz-inkDim">Already paid</h3>
          {result.settled.map((s) => (
            <div key={s.psid} className="payable flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">Bill {s.psid}</div>
                <div className="text-xs text-cz-inkDim mt-0.5">Paid {s.settled_on}</div>
                <a className="text-xs text-cz-primary underline underline-offset-2" href={`/verify?receipt=${s.receipt_no}`}>
                  Receipt {s.receipt_no}
                </a>
              </div>
              <span className="badge badge-paid shrink-0">Paid</span>
            </div>
          ))}
          <p className="text-xs text-cz-inkDim">
            Your receipt is shown here rather than an error, so you don't pay the same bill twice.
          </p>
        </section>
      )}
    </div>
  );
}
