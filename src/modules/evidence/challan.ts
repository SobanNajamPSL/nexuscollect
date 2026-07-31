import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { computeDerived, type SurchargeRule, type EarlyDiscountRule, type RoundingRule } from "../obligation/compute-derived.js";
import { encodeQrPayload } from "../resolution/qr-encode.js";
import { formatMinor } from "../../platform/money/index.js";

/**
 * §8.13: print-and-pay (offline challan). No PDF-rendering library exists in
 * this build's dependencies (checked `package.json`) — this generates the
 * challan's real, computed CONTENT (PSID, live amount, validity date,
 * head-wise breakdown, the same EMVCo QR payload Screen 1 already encodes)
 * as structured data + an HTML rendering, disclosed as that rather than a
 * fabricated PDF binary. A real deployment would pipe this content into a
 * PDF renderer; the numbers themselves are exactly what one would print.
 */
export interface ChallanData {
  psid: string;
  agencyName: string;
  payerName: string;
  description: string;
  amountValidTodayMinor: bigint;
  amountAfterDueDateMinor: bigint;
  dueDate: string;
  headBreakdown: { code: string; name: string; amountMinor: bigint }[];
  qrPayload: string;
  barcodeValue: string; // Code 128 payload is just the PSID digits, per §8.13
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0] as string;
}

export async function generateChallan(db: Kysely<Database>, psid: string, clock: Clock): Promise<ChallanData> {
  const row = await db
    .selectFrom("assessment")
    .innerJoin("agency", "agency.id", "assessment.agency_id")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .select(["assessment.psid", "assessment.description", "assessment.due_date", "assessment.issue_date", "assessment.payer_snapshot", "agency.name as agency_name", "agency.code as agency_code", "collection_product.surcharge_rule", "collection_product.early_discount_rule", "collection_product.rounding_rule"])
    .where("assessment.psid", "=", psid)
    .executeTakeFirstOrThrow();

  const lines = await db
    .selectFrom("assessment_line_item")
    .innerJoin("revenue_head", "revenue_head.id", "assessment_line_item.revenue_head_id")
    .select(["revenue_head.code", "revenue_head.name", "assessment_line_item.line_type", "assessment_line_item.amount_minor", "assessment_line_item.allocated_minor"])
    .where("assessment_line_item.assessment_id", "=", (qb) => qb.selectFrom("assessment").select("id").where("psid", "=", psid).limit(1))
    .execute();

  const principalMinor = lines.filter((l) => l.line_type === "PRINCIPAL").reduce((s, l) => s + l.amount_minor, 0n);
  const otherLinesMinor = lines.filter((l) => l.line_type !== "PRINCIPAL").reduce((s, l) => s + l.amount_minor, 0n);
  const allocatedMinor = lines.reduce((s, l) => s + l.allocated_minor, 0n);
  const rule = { surchargeRule: row.surcharge_rule as SurchargeRule | null, earlyDiscountRule: row.early_discount_rule as EarlyDiscountRule | null, roundingRule: row.rounding_rule as RoundingRule | null };

  const todayIso = clock.now().toISOString().split("T")[0] as string;
  const today = computeDerived({ principalMinor, otherLinesMinor, issueDate: row.issue_date, dueDate: row.due_date, asOfDate: todayIso, ...rule });
  const afterDue = computeDerived({ principalMinor, otherLinesMinor, issueDate: row.issue_date, dueDate: row.due_date, asOfDate: todayIso > row.due_date ? todayIso : addDaysIso(row.due_date, 1), ...rule });

  const snapshot = row.payer_snapshot as { name?: string } | null;
  const qrPayload = encodeQrPayload({ merchantAccountCode: row.agency_code, merchantName: row.agency_name, psid: row.psid, amountMinor: today.payableAmountMinor - allocatedMinor });

  return {
    psid: row.psid,
    agencyName: row.agency_name,
    payerName: snapshot?.name ?? "",
    description: row.description,
    amountValidTodayMinor: today.payableAmountMinor - allocatedMinor,
    amountAfterDueDateMinor: afterDue.payableAmountMinor - allocatedMinor,
    dueDate: row.due_date,
    headBreakdown: lines.map((l) => ({ code: l.code, name: l.name, amountMinor: l.amount_minor })),
    qrPayload,
    barcodeValue: row.psid,
  };
}

export function renderChallanHtml(challan: ChallanData): string {
  const rows = challan.headBreakdown.map((h) => `<tr><td>${h.code} — ${h.name}</td><td style="text-align:right">PKR ${formatMinor(h.amountMinor).replace("PKR ", "")}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Challan ${challan.psid}</title></head><body style="font-family:sans-serif;max-width:640px;margin:2em auto">
<h2>${challan.agencyName}</h2>
<p style="font-size:1.4em;letter-spacing:0.15em"><strong>PSID: ${challan.psid}</strong></p>
<p>${challan.description}</p>
<p>Payer: ${challan.payerName}</p>
<table style="width:100%;border-collapse:collapse">${rows}</table>
<p><strong>Amount valid until ${challan.dueDate}: ${formatMinor(challan.amountValidTodayMinor)}</strong><br>
After that date, pay ${formatMinor(challan.amountAfterDueDateMinor)}. The teller's screen shows the live resolved amount and is authoritative.</p>
<p style="font-family:monospace;word-break:break-all">Barcode (Code 128) value: ${challan.barcodeValue}</p>
<p style="font-family:monospace;word-break:break-all">QR payload: ${challan.qrPayload}</p>
<hr><p>Bank copy</p><hr><p>Payer copy</p><hr><p>Agency copy</p>
</body></html>`;
}
