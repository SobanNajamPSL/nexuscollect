import { SignJWT, jwtVerify } from "jose";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { computeDerived, type SurchargeRule, type EarlyDiscountRule, type RoundingRule } from "../../modules/obligation/compute-derived.js";
import { maskPayerName } from "../../modules/resolution/mask.js";
import { capturePayment, HardDuplicatePaymentError, reversePayment, resolveUncertainPayment } from "../../modules/payment/index.js";
import { toWireMinor } from "../../platform/money/index.js";

/** `modules/evidence/receipt.ts`'s `findReceiptForPayment` looks up by
 * assessment id, not payment id — this adapter needs the receipt tied to a
 * specific payment directly (a switch Bill Payment settles exactly one
 * assessment via its single explicit allocation). */
async function receiptForPaymentId(db: Kysely<Database>, paymentId: string): Promise<string | null> {
  const receipt = await db.selectFrom("receipt").select("receipt_no").where("payment_id", "=", paymentId).executeTakeFirst();
  return receipt?.receipt_no ?? null;
}

/**
 * §8.6's four-message biller contract. No channel conditionals leak into
 * `modules/payment`/`modules/resolution` — this adapter is the ONLY place
 * that knows about switch-specific framing (STAN/RRN, response codes,
 * "always HTTP 200", byte-identical echo fields). It calls straight into the
 * existing capture/reversal primitives Phase 2 already built.
 */

const ALGORITHM = "HS256";
const INQUIRY_TOKEN_TTL_SECONDS = 15 * 60; // an ATM/OTC session window, not specified by the spec — a sane default

function getSwitchSecret(): Uint8Array {
  const secret = process.env["SWITCH_INQUIRY_TOKEN_SECRET"] ?? process.env["RESOLUTION_TOKEN_SECRET"];
  if (!secret) throw new Error("SWITCH_INQUIRY_TOKEN_SECRET (or RESOLUTION_TOKEN_SECRET) is not set");
  return new TextEncoder().encode(secret);
}

export interface SwitchBillInquiryRequest {
  acquirer_id: string;
  stan: string;
  rrn: string;
  txn_date: string;
  consumer_number: string;
  biller_id: string;
  channel?: string;
}

export interface SwitchBillInquiryResponse {
  response_code: string;
  response_reference: string;
  consumer_number: string;
  biller_id: string;
  consumer_name: string | null;
  bill_status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "EXPIRED" | "BLOCKED";
  amount_within_due_date_minor?: number;
  amount_after_due_date_minor?: number;
  due_date?: string | null;
  billing_month?: string | null;
  partial_payment_allowed?: boolean;
  minimum_payable_minor?: number;
  paid_on?: string | null;
  receipt_no?: string | null;
  biller_message: string;
}

async function loadAssessmentForSwitch(db: Kysely<Database>, psid: string) {
  return db
    .selectFrom("assessment")
    .innerJoin("agency", "agency.id", "assessment.agency_id")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .select([
      "assessment.id", "assessment.psid", "assessment.status", "assessment.description",
      "assessment.due_date", "assessment.issue_date", "assessment.payer_snapshot",
      "collection_product.allow_partial", "collection_product.surcharge_rule",
      "collection_product.early_discount_rule", "collection_product.rounding_rule",
    ])
    .where("assessment.psid", "=", psid)
    .executeTakeFirst();
}

async function loadOpenLinesTotals(db: Kysely<Database>, assessmentId: string) {
  const rows = await db.selectFrom("assessment_line_item").select(["line_type", "amount_minor", "allocated_minor"]).where("assessment_id", "=", assessmentId).execute();
  const principalMinor = rows.filter((r) => r.line_type === "PRINCIPAL").reduce((s, r) => s + r.amount_minor, 0n);
  const otherLinesMinor = rows.filter((r) => r.line_type !== "PRINCIPAL").reduce((s, r) => s + r.amount_minor, 0n);
  const allocatedMinor = rows.reduce((s, r) => s + r.allocated_minor, 0n);
  return { principalMinor, otherLinesMinor, allocatedMinor };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0] as string;
}

/** Message 1 of 4 — a pure read. Never writes state that could block a later
 * payment; the only "state" it produces is a signed, short-lived
 * `response_reference` the switch is required to echo back verbatim on
 * Bill Payment, which Bill Payment then verifies rather than looking anything
 * up — keeping this handler a true read. */
export async function billInquiry(db: Kysely<Database>, req: SwitchBillInquiryRequest, clock: Clock): Promise<SwitchBillInquiryResponse> {
  const row = await loadAssessmentForSwitch(db, req.consumer_number);
  if (!row) {
    return {
      response_code: "14", response_reference: "", consumer_number: req.consumer_number, biller_id: req.biller_id,
      consumer_name: null, bill_status: "BLOCKED", biller_message: "Invalid consumer number",
    };
  }

  if (row.status === "SETTLED") {
    const receipt = await db
      .selectFrom("receipt")
      .innerJoin("payment", "payment.id", "receipt.payment_id")
      .innerJoin("payment_allocation", "payment_allocation.payment_id", "payment.id")
      .select(["receipt.receipt_no", "receipt.business_date"])
      .where("payment_allocation.assessment_id", "=", row.id)
      .orderBy("receipt.issued_at", "desc")
      .executeTakeFirst();
    return {
      response_code: "94", response_reference: "", consumer_number: req.consumer_number, biller_id: req.biller_id,
      consumer_name: row.payer_snapshot ? maskPayerName(String((row.payer_snapshot as { name?: string }).name ?? "")) : null,
      bill_status: "PAID", paid_on: receipt?.business_date ?? null, receipt_no: receipt?.receipt_no ?? null,
      biller_message: receipt ? `Already paid on ${receipt.business_date}` : "Already paid",
    };
  }

  if (!["ISSUED", "PARTIALLY_PAID", "OVERDUE"].includes(row.status)) {
    return {
      response_code: "91", response_reference: "", consumer_number: req.consumer_number, biller_id: req.biller_id,
      consumer_name: null, bill_status: "BLOCKED", biller_message: `Bill not payable (status ${row.status})`,
    };
  }

  const { principalMinor, otherLinesMinor, allocatedMinor } = await loadOpenLinesTotals(db, row.id);
  const todayIso = clock.now().toISOString().split("T")[0] as string;
  const withinRule = { surchargeRule: row.surcharge_rule as SurchargeRule | null, earlyDiscountRule: row.early_discount_rule as EarlyDiscountRule | null, roundingRule: row.rounding_rule as RoundingRule | null };
  const within = computeDerived({ principalMinor, otherLinesMinor, issueDate: row.issue_date, dueDate: row.due_date, asOfDate: todayIso, ...withinRule });
  const afterAsOf = todayIso > row.due_date ? todayIso : addDaysIso(row.due_date, 1);
  const after = computeDerived({ principalMinor, otherLinesMinor, issueDate: row.issue_date, dueDate: row.due_date, asOfDate: afterAsOf, ...withinRule });

  const amountWithin = within.payableAmountMinor - allocatedMinor;
  const amountAfter = after.payableAmountMinor - allocatedMinor;

  const responseReference = await new SignJWT({
    psid: row.psid, amountWithinMinor: amountWithin.toString(), amountAfterMinor: amountAfter.toString(), consumerNumber: req.consumer_number,
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt(Math.floor(clock.now().getTime() / 1000))
    .setExpirationTime(Math.floor(clock.now().getTime() / 1000) + INQUIRY_TOKEN_TTL_SECONDS)
    .sign(getSwitchSecret());

  return {
    response_code: "00",
    response_reference: responseReference,
    consumer_number: req.consumer_number,
    biller_id: req.biller_id,
    consumer_name: row.payer_snapshot ? maskPayerName(String((row.payer_snapshot as { name?: string }).name ?? "")) : null,
    bill_status: allocatedMinor > 0n ? "PARTIALLY_PAID" : "UNPAID",
    amount_within_due_date_minor: toWireMinor(amountWithin),
    amount_after_due_date_minor: toWireMinor(amountAfter),
    due_date: row.due_date,
    partial_payment_allowed: row.allow_partial,
    minimum_payable_minor: toWireMinor(row.allow_partial ? 0n : amountWithin),
    biller_message: row.description,
  };
}

export interface SwitchBillPaymentRequest {
  acquirer_id: string;
  stan: string;
  rrn: string;
  txn_date: string;
  consumer_number: string;
  biller_id: string;
  response_reference: string;
  transaction_amount_minor: bigint;
  channel?: string;
}

export interface SwitchBillPaymentResponse {
  response_code: string;
  stan: string;
  rrn: string;
  payment_reference: string;
  receipt_no: string;
  settled_amount_minor: number;
  remaining_balance_minor: number;
  biller_message: string;
}

export class SwitchInquiryTokenInvalidError extends Error {
  constructor(reason: string) {
    super(`response_reference is invalid or expired: ${reason}`);
    this.name = "SwitchInquiryTokenInvalidError";
  }
}

/** Message 2 of 4 — the money message. Idempotent on the switch's own keys
 * (`acquirer_id, stan, rrn, txn_date` — `capturePayment`'s hard-duplicate
 * tier already enforces this via `ux_payment_switch`); never returns
 * `UNCERTAIN` to a switch (§9.4's rule 4) — either recorded, or a definite
 * failure. */
export async function billPayment(db: Kysely<Database>, req: SwitchBillPaymentRequest, clock: Clock): Promise<SwitchBillPaymentResponse> {
  let claims: { psid: string; amountWithinMinor: string; amountAfterMinor: string; consumerNumber: string };
  try {
    const verified = await jwtVerify(req.response_reference, getSwitchSecret(), { currentDate: clock.now() });
    claims = verified.payload as never;
  } catch (err) {
    throw new SwitchInquiryTokenInvalidError(err instanceof Error ? err.message : "malformed token");
  }
  if (claims.consumerNumber !== req.consumer_number) {
    throw new SwitchInquiryTokenInvalidError("consumer_number does not match the inquiry that minted this response_reference");
  }

  try {
    const result = await capturePayment(
      db,
      {
        paymentReference: "", channel: "BILLER", rail: "IBFT_1LINK",
        grossAmountMinor: req.transaction_amount_minor, valueDate: req.txn_date, obligationDischargeDate: req.txn_date,
        switchStan: req.stan, switchRrn: req.rrn, acquirerId: req.acquirer_id,
        explicitAllocations: [{ psid: claims.psid, amountMinor: req.transaction_amount_minor }],
        captureOutcome: "CONFIRMED",
      },
      clock,
    );
    const receiptNo = await receiptForPaymentId(db, result.paymentId);
    const paymentRow = await db.selectFrom("payment").select(["payment_reference", "acquirer_id", "switch_stan", "switch_rrn", "value_date"]).where("id", "=", result.paymentId).executeTakeFirstOrThrow();
    await tryPairPendingReversal(db, { id: result.paymentId, ...paymentRow }, clock);
    return {
      response_code: "00", stan: req.stan, rrn: req.rrn, payment_reference: paymentRow.payment_reference,
      receipt_no: receiptNo ?? "", settled_amount_minor: toWireMinor(req.transaction_amount_minor - result.unappliedAmountMinor),
      remaining_balance_minor: toWireMinor(result.unappliedAmountMinor), biller_message: "Payment successful",
    };
  } catch (err) {
    if (err instanceof HardDuplicatePaymentError) {
      // §8.6: idempotent replay on the switch's own keys — return the
      // ORIGINAL payment's outcome, never a rejection of money already recorded.
      const original = await db
        .selectFrom("payment")
        .selectAll()
        .where("acquirer_id", "=", req.acquirer_id).where("switch_stan", "=", req.stan).where("switch_rrn", "=", req.rrn).where("value_date", "=", req.txn_date)
        .executeTakeFirstOrThrow();
      const receiptNo = await receiptForPaymentId(db, original.id);
      return {
        response_code: "00", stan: req.stan, rrn: req.rrn, payment_reference: original.payment_reference,
        receipt_no: receiptNo ?? "", settled_amount_minor: toWireMinor(original.gross_amount_minor - original.unapplied_amount_minor),
        remaining_balance_minor: toWireMinor(original.unapplied_amount_minor), biller_message: "Duplicate request — returning original outcome",
      };
    }
    throw err;
  }
}

export interface SwitchReversalRequest {
  acquirer_id: string;
  original_stan: string;
  original_rrn: string;
  txn_date: string;
  transaction_amount_minor?: bigint;
  reversal_reason: "TIMEOUT" | "CUSTOMER_CANCELLED" | "TECHNICAL" | "DUPLICATE" | "LATE_RESPONSE";
}

export interface SwitchReversalResponse {
  response_code: string;
  reversal_state: "REVERSED" | "PENDING_ORIGINAL" | "NOT_REVERSIBLE";
  original_payment_reference: string | null;
}

/** Message 3 of 4. §8.6's hard requirement: safe against a reversal that
 * arrives before its original payment (a frequent condition when Bill
 * Payment timed out on the switch side). If no original exists yet, the
 * reversal is stored `PENDING_ORIGINAL` and auto-paired the moment the late
 * original lands (see `billPayment`'s call to `tryPairPendingReversal`). */
export async function billPaymentReversal(db: Kysely<Database>, req: SwitchReversalRequest, clock: Clock): Promise<SwitchReversalResponse> {
  const original = await db
    .selectFrom("payment")
    .selectAll()
    .where("acquirer_id", "=", req.acquirer_id).where("switch_stan", "=", req.original_stan).where("switch_rrn", "=", req.original_rrn).where("value_date", "=", req.txn_date)
    .executeTakeFirst();

  if (!original) {
    await db
      .insertInto("switch_pending_reversal")
      .values({
        acquirer_id: req.acquirer_id, original_stan: req.original_stan, original_rrn: req.original_rrn, txn_date: req.txn_date,
        transaction_amount_minor: req.transaction_amount_minor ?? null, reversal_reason: req.reversal_reason,
      })
      .onConflict((oc) => oc.columns(["acquirer_id", "original_stan", "original_rrn", "txn_date"]).where("status", "=", "PENDING_ORIGINAL").doNothing())
      .execute();
    return { response_code: "00", reversal_state: "PENDING_ORIGINAL", original_payment_reference: null };
  }

  if (original.status === "REVERSED") {
    return { response_code: "00", reversal_state: "REVERSED", original_payment_reference: original.payment_reference };
  }
  if (!["CONFIRMED", "PARTIALLY_REVERSED"].includes(original.status)) {
    return { response_code: "96", reversal_state: "NOT_REVERSIBLE", original_payment_reference: original.payment_reference };
  }

  await reversePayment(db, original.id, `Switch reversal: ${req.reversal_reason}`, { actorType: "INSTITUTION", actorId: req.acquirer_id }, clock);
  return { response_code: "00", reversal_state: "REVERSED", original_payment_reference: original.payment_reference };
}

/** Called after a fresh `billPayment` capture to auto-pair any reversal that
 * arrived earlier than its original — closes exactly the race §8.6 describes.
 * Takes the top-level `db`, not a `Transaction`: `reversePayment` opens its
 * OWN transaction internally, and Kysely doesn't support nesting one
 * transaction inside another — this runs as two sequential atomic steps
 * (the reversal, then marking the pending row resolved) rather than one. */
export async function tryPairPendingReversal(db: Kysely<Database>, payment: { id: string; acquirer_id: string | null; switch_stan: string | null; switch_rrn: string | null; value_date: string }, clock: Clock): Promise<boolean> {
  if (!payment.acquirer_id || !payment.switch_stan || !payment.switch_rrn) return false;
  const pending = await db
    .selectFrom("switch_pending_reversal")
    .selectAll()
    .where("acquirer_id", "=", payment.acquirer_id).where("original_stan", "=", payment.switch_stan).where("original_rrn", "=", payment.switch_rrn).where("txn_date", "=", payment.value_date)
    .where("status", "=", "PENDING_ORIGINAL")
    .executeTakeFirst();
  if (!pending) return false;
  await reversePayment(db, payment.id, `Late-paired switch reversal: ${pending.reversal_reason}`, { actorType: "INSTITUTION", actorId: payment.acquirer_id }, clock);
  await db.updateTable("switch_pending_reversal").set({ status: "PAIRED_AND_REVERSED", resolved_payment_id: payment.id, resolved_at: clock.now() }).where("id", "=", pending.id).execute();
  return true;
}

export interface SwitchAdviceRequest {
  acquirer_id: string;
  original_stan: string;
  original_rrn: string;
  txn_date: string;
  advice_outcome: "CONFIRMED" | "FAILED";
}

export interface SwitchAdviceResponse {
  response_code: string;
  resolved_status: string;
}

/** Message 4 of 4 — late confirmation resolving a payment held `UNCERTAIN` (§9.4). */
export async function billPaymentAdvice(db: Kysely<Database>, req: SwitchAdviceRequest, clock: Clock): Promise<SwitchAdviceResponse> {
  const payment = await db
    .selectFrom("payment")
    .select(["id", "status"])
    .where("acquirer_id", "=", req.acquirer_id).where("switch_stan", "=", req.original_stan).where("switch_rrn", "=", req.original_rrn).where("value_date", "=", req.txn_date)
    .executeTakeFirst();
  if (!payment || payment.status !== "UNCERTAIN") {
    return { response_code: "96", resolved_status: payment?.status ?? "NOT_FOUND" };
  }
  await resolveUncertainPayment(db, payment.id, { outcome: req.advice_outcome === "CONFIRMED" ? "FOUND_PAID" : "FOUND_NOT_PAID", source: "AGGREGATOR_ADVICE" }, clock);
  const updated = await db.selectFrom("payment").select("status").where("id", "=", payment.id).executeTakeFirstOrThrow();
  return { response_code: "00", resolved_status: updated.status };
}
