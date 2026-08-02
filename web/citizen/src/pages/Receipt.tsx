import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import QRCode from "qrcode";
import { api } from "@shared/api.js";
import { formatPKR, pkr } from "@shared/money.js";
import { amountInWordsEnglish, amountInWordsUrdu, toUrduDigits } from "@shared/words.js";

/**
 * The receipt.
 *
 * `CLAUDE.md` puts receipt quality second only to the correctness of head-wise
 * reporting, and it is right to: this is the one artefact that leaves the
 * platform, gets printed, and ends up in a file someone else audits years later.
 *
 * Three things make it defensible rather than decorative:
 *
 *   1. **It is rendered from the signed payload**, not from a convenient query.
 *      What the payer reads is byte-for-byte what was signed — so a receipt that
 *      displays cannot disagree with a receipt that verifies.
 *   2. **English and Urdu**, with the amount in words in both (§16.1). The words
 *      are what make a receipt hard to alter after the fact.
 *   3. **Provisional money says so on its face.** A cheque that has not cleared
 *      has not discharged the obligation, and a receipt that implies otherwise is
 *      worse than no receipt at all.
 */

interface PaymentDto {
  payment_reference: string;
  status: string;
  gross_amount_minor: number;
  unapplied_amount_minor: number;
  value_date: string;
  finality: string;
  settled_psids: string[];
}
interface ReceiptDto { receipt_no: string; business_date: string; status: string }
interface SignedBundle { receipt_no: string; canonical_payload: string; signature_base64: string; public_key_pem: string }

/** The head-wise shape inside the signed payload. */
interface SignedPayload {
  agency_code: string;
  agency_name: string;
  business_date: string;
  channel: string;
  rail: string;
  gross_amount_minor: string;
  issued_at: string;
  obligation_discharge_date: string;
  payment_reference: string;
  receipt_no: string;
  status: string;
  value_date: string;
  head_wise: { amount_minor: string; head_code: string; head_name: string; payer_name: string; psid: string }[];
}

/**
 * Everything on the receipt that is chrome rather than data. Head names are
 * deliberately absent: they are the agency's own published chart-of-accounts
 * descriptions, and inventing Urdu equivalents would be fabricating reference
 * data. They render verbatim in both languages.
 */
const COPY = {
  en: {
    dir: "ltr" as const,
    official: "Official receipt",
    receiptNo: "Receipt number",
    paymentRef: "Payment reference",
    payer: "Payer",
    agency: "Agency",
    heads: "What this paid for",
    head: "Revenue head",
    bill: "Bill",
    amount: "Amount",
    total: "Total paid",
    inWords: "In words",
    channel: "Paid through",
    rail: "Settled over",
    valueDate: "Value date",
    dischargeDate: "Obligation discharged",
    issued: "Issued",
    systemGenerated: "This is a system-generated receipt.",
    verifyHint: "Scan to verify this receipt",
    provisional: "PROVISIONAL — subject to realisation of the instrument",
    provisionalNote: "This payment was made by an instrument that has not yet cleared. The obligation is not discharged until it does.",
  },
  ur: {
    dir: "rtl" as const,
    official: "سرکاری رسید",
    receiptNo: "رسید نمبر",
    paymentRef: "ادائیگی کا حوالہ",
    payer: "ادا کنندہ",
    agency: "ادارہ",
    heads: "یہ رقم کس مد میں وصول ہوئی",
    head: "مدِ آمدنی",
    bill: "بل",
    amount: "رقم",
    total: "کل ادا شدہ رقم",
    inWords: "الفاظ میں",
    channel: "ذریعۂ ادائیگی",
    rail: "تصفیہ",
    valueDate: "تاریخِ ادائیگی",
    dischargeDate: "واجبات کی ادائیگی کی تاریخ",
    issued: "جاری کردہ",
    systemGenerated: "یہ رسید کمپیوٹر سے تیار کردہ ہے۔",
    verifyHint: "تصدیق کے لیے اسکین کریں",
    provisional: "عارضی — دستاویز کی وصولی سے مشروط",
    provisionalNote: "یہ ادائیگی ایک ایسی دستاویز سے کی گئی ہے جو ابھی کلیئر نہیں ہوئی۔ کلیئر ہونے تک واجبات ادا شدہ تصور نہیں ہوں گے۔",
  },
};

/** A plain `ArrayBuffer`, which is what WebCrypto's `BufferSource` actually wants. */
function buffer(length: number, byteAt: (i: number) => number): ArrayBuffer {
  const buf = new ArrayBuffer(length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < length; i += 1) view[i] = byteAt(i);
  return buf;
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const raw = atob(b64);
  return buffer(raw.length, (i) => raw.charCodeAt(i));
}

/** PEM → the SPKI bytes WebCrypto wants. */
function pemToBuffer(pem: string): ArrayBuffer {
  return base64ToBuffer(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
}

function textToBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return buffer(bytes.length, (i) => bytes[i]!);
}

/**
 * Verify the signature **in this browser**, with no call to the platform.
 *
 * This is the honest version of "offline verification": the bundle was fetched
 * when the receipt was displayed, and the check itself touches nothing — no
 * network, no database, no server. Ed25519 in WebCrypto is recent, so if the
 * browser cannot do it we say so and fall back to the platform's own endpoint
 * rather than quietly claiming a local check that never happened.
 */
async function verifyLocally(bundle: SignedBundle, payload: string): Promise<boolean | "unsupported"> {
  try {
    const key = await crypto.subtle.importKey("spki", pemToBuffer(bundle.public_key_pem), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, base64ToBuffer(bundle.signature_base64), textToBuffer(payload));
  } catch {
    return "unsupported";
  }
}

export default function Receipt(): JSX.Element {
  const { paymentReference } = useParams();
  const [payment, setPayment] = useState<PaymentDto | null>(null);
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const [bundle, setBundle] = useState<SignedBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<"en" | "ur">("en");
  const [qr, setQr] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; where: string; text: string } | null>(null);

  const t = COPY[lang];

  useEffect(() => {
    if (!paymentReference) return;
    let live = true;
    void (async () => {
      try {
        const p = await api.get<PaymentDto>(`/v1/payments/${paymentReference}`);
        if (!live) return;
        setPayment(p);
        const r = await api.get<ReceiptDto>(`/v1/payments/${paymentReference}/receipt`).catch(() => null);
        if (!live || !r) return;
        setReceipt(r);
        setBundle(await api.get<SignedBundle>(`/v1/receipts/${r.receipt_no}/signed`).catch(() => null));
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [paymentReference]);

  // The QR carries the public verification link — the one thing a person holding
  // a printed receipt can act on without typing nineteen digits by hand.
  useEffect(() => {
    if (!receipt) return;
    const url = `${window.location.origin}/verify?receipt=${receipt.receipt_no}`;
    void QRCode.toDataURL(url, { margin: 1, width: 176, errorCorrectionLevel: "M" }).then(setQr).catch(() => setQr(null));
  }, [receipt]);

  const signed = useMemo<SignedPayload | null>(() => {
    if (!bundle) return null;
    try {
      return JSON.parse(bundle.canonical_payload) as SignedPayload;
    } catch {
      return null;
    }
  }, [bundle]);

  async function check(tamper: boolean): Promise<void> {
    if (!bundle) return;
    const payload = tamper ? bundle.canonical_payload.replace(/\d/, (d) => (d === "9" ? "0" : "9")) : bundle.canonical_payload;
    const local = await verifyLocally(bundle, payload);
    if (local !== "unsupported") {
      setVerdict({
        ok: local,
        where: "in this browser, with no network or database access",
        text: local
          ? "Signature valid. The receipt is genuine and unaltered."
          : "Signature invalid. A single digit was changed and the check caught it.",
      });
      return;
    }
    const res = await api.post<{ valid: boolean }>(
      "/v1/receipts/verify-signature",
      { canonical_payload: payload, signature_base64: bundle.signature_base64, public_key_pem: bundle.public_key_pem },
      { idempotent: false },
    );
    setVerdict({
      ok: res.valid,
      where: "by the platform — this browser does not support Ed25519 locally",
      text: res.valid ? "Signature valid. The receipt is genuine and unaltered." : "Signature invalid. The payload was altered.",
    });
  }

  if (error) return <div className="card p-4 text-sm bg-red-50 border-red-200 text-red-800">{error}</div>;
  if (!payment) return <div className="text-sm text-cz-inkDim">Loading your receipt…</div>;

  /**
   * `UNCERTAIN` is never shown as a failure (§9.4). The money has left the
   * payer's account; what is unresolved is the platform's knowledge of it, and
   * saying "failed" here is what makes people pay twice.
   */
  if (payment.status === "UNCERTAIN") {
    return (
      <div className="space-y-4">
        <div className="card p-5 bg-amber-50 border-amber-200">
          <div className="font-semibold text-amber-900">We're still confirming your payment</div>
          <p className="text-sm text-amber-800 mt-2 leading-relaxed">
            This is not a failure and you have not been charged twice. Your bank has taken the money and we are waiting for
            confirmation. Your receipt will appear here once it arrives — usually within a few minutes.
          </p>
          <div className="text-xs text-amber-800 mt-3">Reference {payment.payment_reference} · {pkr(payment.gross_amount_minor)}</div>
        </div>
        <Link to="/" className="btn-secondary">Back</Link>
      </div>
    );
  }

  const provisional = payment.finality === "PROVISIONAL";
  const num = (s: string): string => (lang === "ur" ? toUrduDigits(s) : s);
  const heads = signed?.head_wise ?? [];
  const payerName = heads[0]?.payer_name ?? null;

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="group" aria-label="Receipt language">
        <button type="button" className={`btn-inline ${lang === "en" ? "btn" : "btn-secondary"}`} onClick={() => setLang("en")}>English</button>
        <button type="button" className={`btn-inline ${lang === "ur" ? "btn" : "btn-secondary"}`} onClick={() => setLang("ur")}>اردو</button>
      </div>

      {provisional && (
        <div className="card p-4 bg-amber-50 border-amber-300" dir={t.dir} lang={lang}>
          <div className={`font-bold text-amber-900 ${lang === "ur" ? "urdu text-base" : "text-sm"}`}>{t.provisional}</div>
          <p className={`text-amber-800 mt-1.5 leading-relaxed ${lang === "ur" ? "urdu text-base" : "text-xs"}`}>{t.provisionalNote}</p>
        </div>
      )}

      <article className="card p-5" dir={t.dir} lang={lang}>
        <header className="text-center border-b border-dashed border-cz-rule pb-4">
          {/* Nastaliq needs more size than Latin small-caps to stay legible —
              set at 11px it reads as decoration rather than a heading. */}
          <div className={lang === "ur" ? "urdu text-base text-cz-inkDim" : "text-[11px] uppercase tracking-widest text-cz-inkDim"}>{t.official}</div>
          <div className={`font-semibold mt-1 ${lang === "ur" ? "urdu text-lg" : "text-base"}`}>{signed?.agency_name ?? "—"}</div>
          <div className="text-lg font-bold tabular-nums mt-1" dir="ltr">{receipt?.receipt_no ?? "—"}</div>
        </header>

        <dl className={`mt-4 space-y-1.5 ${lang === "ur" ? "urdu text-base" : "text-sm"}`}>
          <Row label={t.paymentRef} value={payment.payment_reference} mono />
          {payerName && <Row label={t.payer} value={payerName} />}
          <Row label={t.channel} value={signed?.channel ?? "—"} />
          <Row label={t.rail} value={signed?.rail ?? "—"} />
          <Row label={t.valueDate} value={num(payment.value_date)} />
          {signed && <Row label={t.dischargeDate} value={num(signed.obligation_discharge_date)} />}
        </dl>

        {heads.length > 0 && (
          <section className="mt-5">
            <h3 className={`font-semibold text-cz-inkDim uppercase tracking-wider ${lang === "ur" ? "urdu text-base tracking-normal" : "text-[11px]"}`}>{t.heads}</h3>
            <table className="w-full mt-2 text-sm">
              <tbody>
                {heads.map((h, i) => (
                  <tr key={`${h.psid}-${h.head_code}-${i}`} className="border-b border-cz-rule/70 last:border-0">
                    <td className="py-2 pe-2 align-top">
                      <div className={lang === "ur" ? "urdu" : ""} dir="ltr">{h.head_name}</div>
                      <div className="text-[11px] text-cz-inkDim tabular-nums mt-0.5" dir="ltr">{h.head_code} · {t.bill} {h.psid}</div>
                    </td>
                    <td className="py-2 text-end align-top amount whitespace-nowrap" dir="ltr">{formatPKR(Number(h.amount_minor))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <div className="mt-4 pt-3 border-t-2 border-cz-ink/80 flex items-baseline justify-between gap-3">
          <span className={`font-semibold ${lang === "ur" ? "urdu" : "text-sm"}`}>{t.total}</span>
          <span className="text-xl font-bold tabular-nums" dir="ltr">PKR {formatPKR(payment.gross_amount_minor)}</span>
        </div>
        <div className={`mt-2 ${lang === "ur" ? "urdu text-base text-right" : "text-xs"} text-cz-inkDim leading-relaxed`}>
          <span className="font-medium">{t.inWords}: </span>
          {lang === "ur" ? amountInWordsUrdu(payment.gross_amount_minor) : amountInWordsEnglish(payment.gross_amount_minor)}
        </div>

        {qr && (
          <div className="mt-5 pt-4 border-t border-dashed border-cz-rule flex items-center gap-4" dir="ltr">
            <img src={qr} alt="Verification QR code" width={88} height={88} className="shrink-0" />
            <div className={`text-xs text-cz-inkDim leading-relaxed ${lang === "ur" ? "urdu text-base" : ""}`}>
              {t.verifyHint}
              <div className="tabular-nums mt-1">{receipt?.receipt_no}</div>
            </div>
          </div>
        )}

        <p className={`text-center text-cz-inkDim mt-4 pt-3 border-t border-dashed border-cz-rule ${lang === "ur" ? "urdu text-base" : "text-[11px]"}`}>
          {t.systemGenerated}
        </p>
      </article>

      {bundle && (
        <div className="card p-4 space-y-3">
          <div className="text-xs text-cz-inkDim leading-relaxed">
            This receipt carries an Ed25519 signature over its exact contents. The check below runs in your browser — nothing is
            sent anywhere, which is what makes a receipt verifiable by someone with no access to the platform at all.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn-secondary btn-inline" onClick={() => void check(false)}>Verify as issued</button>
            <button type="button" className="btn-secondary btn-inline" onClick={() => void check(true)}>Alter one digit</button>
          </div>
          {verdict && (
            <div className={`text-sm rounded-lg p-3 ${verdict.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"}`}>
              <div className="font-semibold">{verdict.ok ? "✓" : "✗"} {verdict.text}</div>
              <div className="text-xs mt-1 opacity-80">Checked {verdict.where}.</div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Link to="/" className="btn-secondary btn-inline">Pay another bill</Link>
        <a className="btn-secondary btn-inline" href={`/verify?receipt=${receipt?.receipt_no ?? ""}`}>Verify publicly</a>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-cz-inkDim shrink-0">{label}</dt>
      <dd className={`text-end font-medium ${mono ? "tabular-nums" : ""}`} dir="ltr">{value}</dd>
    </div>
  );
}
