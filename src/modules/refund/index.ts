import { randomBytes } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";
import { getOrCreateLedgerAccount } from "../ledger/index.js";
import { postJournalTemplate } from "../journal-templates/index.js";
import { reversePayment } from "../payment/index.js";

/**
 * §14.1 refunds, §14.2 downward amendment, §14.7 disputes' liability side.
 * Two distinct paths per §14.1's own instruction: `SURPLUS_ONLY` never
 * touches an allocation; `FULL_REVERSAL` reuses `modules/payment.reversePayment`
 * (which itself already knows about §14.3 step 7's post-sweep receivable).
 */

function generateRefundReference(): string {
  return `RF${randomBytes(6).toString("hex").toUpperCase()}`;
}

export type RefundReasonCode = "OVERPAYMENT" | "DUPLICATE" | "CANCELLED_SERVICE" | "ASSESSMENT_AMENDED" | "ERRONEOUS_PAYMENT" | "DEPOSIT_RELEASE" | "COURT_ORDER";
export type RefundMode = "SURPLUS_ONLY" | "FULL_REVERSAL";
export type FundingSource = "PLATFORM_HELD" | "AGENCY_FUNDED";

export interface CreateRefundInput {
  paymentId: string;
  amountMinor: bigint;
  reasonCode: RefundReasonCode;
  mode: RefundMode;
  fundingSource: FundingSource;
  /** §14.1/§8.14: "Defaults to the original debit account. Any change
   * requires an approved override" — omit to keep the default; supplying a
   * masked account here IS the override and forces PENDING_APPROVAL with
   * `beneficiary_overridden = true`, which the approval gate gates on. */
  overrideBeneficiaryAccountMasked?: string;
  actorId: string;
}

export class RefundExceedsRemainingError extends Error {
  readonly httpStatus = 422;
  readonly code = "REFUND_EXCEEDS_REMAINING";
  constructor(paymentId: string, requested: bigint, remaining: bigint) {
    super(`Refund of ${requested} on payment ${paymentId} exceeds the remaining refundable amount (${remaining}) — §14.1: capped at gross − already_refunded`);
    this.name = "RefundExceedsRemainingError";
  }
}

/** §14.1: "Partial supported; multiple refunds against one payment, capped at
 * gross − already_refunded." */
export async function createRefund(db: Kysely<Database>, input: CreateRefundInput, clock: Clock): Promise<{ refundId: string; refundReference: string; status: string }> {
  const run = async (trx: Transaction<Database>) => {
    const payment = await trx.selectFrom("payment").selectAll().where("id", "=", input.paymentId).executeTakeFirstOrThrow();
    const alreadyRefunded = await trx
      .selectFrom("refund")
      .select(({ fn }) => fn.sum<bigint>("amount_minor").as("total"))
      .where("payment_id", "=", input.paymentId)
      .where("status", "in", ["PENDING_APPROVAL", "APPROVED", "PAID"])
      .executeTakeFirst();
    const remaining = payment.gross_amount_minor - BigInt(alreadyRefunded?.total ?? 0n);
    if (input.amountMinor > remaining) throw new RefundExceedsRemainingError(input.paymentId, input.amountMinor, remaining);

    const refundReference = generateRefundReference();
    const overridden = Boolean(input.overrideBeneficiaryAccountMasked);
    const inserted = await trx
      .insertInto("refund")
      .values({
        refund_reference: refundReference,
        payment_id: input.paymentId,
        amount_minor: input.amountMinor,
        reason_code: input.reasonCode,
        mode: input.mode,
        funding_source: input.fundingSource,
        beneficiary_overridden: overridden,
        // Default beneficiary is the ORIGINAL debit account (§14.1) — never
        // invented; only set when the caller explicitly overrides it.
        beneficiary_account_masked: input.overrideBeneficiaryAccountMasked ?? payment.payer_account_masked ?? null,
        status: "PENDING_APPROVAL",
        created_at: clock.now(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await appendAuditEntry(trx, { actorType: "USER", actorId: input.actorId, action: "refund.created", entityType: "refund", entityId: inserted.id, beforeJson: null, afterJson: { refundReference, amountMinor: input.amountMinor.toString(), mode: input.mode, overridden } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "refund", aggregateId: inserted.id, sequence: 1, eventType: "refund.created", payload: { refundReference, paymentId: input.paymentId } }, clock);

    return { refundId: inserted.id, refundReference, status: "PENDING_APPROVAL" };
  };

  return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run);
}

export class SelfApprovalError extends Error {
  readonly httpStatus = 409;
  readonly code = "SELF_APPROVAL_NOT_ALLOWED";
  constructor() {
    super("The maker of a refund cannot also approve it — enforced by the database (ck_segregation on approval)");
    this.name = "SelfApprovalError";
  }
}

/** Maker-checker, same real DB-level segregation the `approval` table
 * already enforces (`ck_segregation`) — a self-approval attempt fails at the
 * database, not merely the UI, matching Group D's D1 test. */
export async function approveRefund(db: Kysely<Database>, refundId: string, checkerUserId: string, makerUserId: string, clock: Clock): Promise<void> {
  if (checkerUserId === makerUserId) throw new SelfApprovalError();
  await db.transaction().execute(async (trx) => {
    const refund = await trx.selectFrom("refund").selectAll().where("id", "=", refundId).executeTakeFirstOrThrow();
    if (refund.status !== "PENDING_APPROVAL") throw new Error(`Refund ${refundId} is not PENDING_APPROVAL (currently ${refund.status})`);

    const approval = await trx
      .insertInto("approval")
      .values({ subject_type: "refund", subject_id: refundId, action: "APPROVE_REFUND", amount_minor: refund.amount_minor, payload: JSON.stringify({ refundReference: refund.refund_reference }) as never, maker_user_id: makerUserId, maker_at: clock.now(), checker_user_id: checkerUserId, checker_at: clock.now(), state: "APPROVED" })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx.updateTable("refund").set({ status: "APPROVED", approval_id: approval.id }).where("id", "=", refundId).execute();
    await appendAuditEntry(trx, { actorType: "USER", actorId: checkerUserId, action: "refund.approved", entityType: "refund", entityId: refundId, beforeJson: { status: "PENDING_APPROVAL" }, afterJson: { status: "APPROVED" } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "refund", aggregateId: refundId, sequence: 2, eventType: "refund.approved", payload: { refundId } }, clock);
  });
}

/**
 * Moves the money. `FULL_REVERSAL` reuses `reversePayment` (which already
 * restores allocations/balances and — since Phase 5 — raises the post-sweep
 * receivable automatically when applicable); `SURPLUS_ONLY` leaves every
 * allocation untouched and only relieves the surplus sitting in `2030`.
 * Posts T19 then T20 (§14.1's own ledger sequence) in both cases.
 */
export async function payRefund(db: Kysely<Database>, refundId: string, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx: Transaction<Database>) => {
    const refund = await trx.selectFrom("refund").selectAll().where("id", "=", refundId).executeTakeFirstOrThrow();
    if (refund.status !== "APPROVED") throw new Error(`Refund ${refundId} is not APPROVED (currently ${refund.status})`);
    const payment = await trx.selectFrom("payment").selectAll().where("id", "=", refund.payment_id).executeTakeFirstOrThrow();

    if (refund.mode === "FULL_REVERSAL") {
      await reversePayment(trx, refund.payment_id, `Refund ${refund.refund_reference}: ${refund.reason_code}`, { actorType: "SYSTEM", actorId: "refund-engine" }, clock);
    }

    if (payment.agency_id) {
      const agencyCode = (await trx.selectFrom("agency").select("code").where("id", "=", payment.agency_id).executeTakeFirstOrThrow()).code;
      // T19: the surplus (SURPLUS_ONLY) or the just-reversed balance
      // (FULL_REVERSAL) moves from its holding account into Refunds Payable.
      const debitBase = refund.mode === "SURPLUS_ONLY" ? "2030" : "2010";
      const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: debitBase, dimensionKey: agencyCode, name: refund.mode === "SURPLUS_ONLY" ? "Overpayment Payable" : "Agency Payable", accountType: "LIABILITY", normalBalance: "CR", agencyId: payment.agency_id });
      const refundsPayableCode = await getOrCreateLedgerAccount(trx, { baseCode: "2050", dimensionKey: "PLATFORM", name: "Refunds Payable", accountType: "LIABILITY", normalBalance: "CR" });
      await postJournalTemplate(trx, { eventType: "REFUND_APPROVED", debitAccountCode: debitCode, creditAccountCode: refundsPayableCode, amountMinor: refund.amount_minor, sourceType: "refund", sourceId: refundId, agencyId: payment.agency_id, valueDate: payment.value_date, ...(refund.approval_id ? { approvalId: refund.approval_id } : {}) }, clock);

      // T20: the actual payout — no live rail to call in this demo, recorded
      // as the same "no real rail" disclosure the rest of this build uses
      // (Phase 2's capturePayment, Phase 4's runSweep).
      const bankCode = await getOrCreateLedgerAccount(trx, { baseCode: "1100", dimensionKey: "PLATFORM", name: "Collection Bank", accountType: "ASSET", normalBalance: "DR" });
      await postJournalTemplate(trx, { eventType: "REFUND_PAID", debitAccountCode: refundsPayableCode, creditAccountCode: bankCode, amountMinor: refund.amount_minor, sourceType: "refund", sourceId: refundId, sequence: 2, agencyId: payment.agency_id, valueDate: payment.value_date }, clock);
    }

    await trx.updateTable("refund").set({ status: "PAID", paid_at: clock.now() }).where("id", "=", refundId).execute();
    await appendAuditEntry(trx, { actorType: "SYSTEM", actorId: "refund-engine", action: "refund.paid", entityType: "refund", entityId: refundId, beforeJson: { status: "APPROVED" }, afterJson: { status: "PAID" } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "refund", aggregateId: refundId, sequence: 3, eventType: "refund.paid", payload: { refundId, amountMinor: refund.amount_minor.toString() } }, clock);
  });
}

export { detectProbableDuplicate } from "./duplicate-detection.js";

/** §14.2: an assessment amended below the amount already paid recognises an
 * overpayment. Routes it per the product's `overpay_treatment`, creating a
 * REAL refund (PENDING_APPROVAL for AUTO_REFUND, left uncreated for
 * CREDIT_ON_ACCOUNT/hold — those are different, legitimate dispositions of
 * the same surplus, not a refund at all). */
export async function createRefundForAmendment(
  db: Kysely<Database>,
  input: { assessmentId: string; overpaymentRecognisedMinor: bigint; overpayTreatment: "REJECT" | "CREDIT_ON_ACCOUNT" | "AUTO_REFUND" | "ABSORB"; actorId: string },
  clock: Clock,
): Promise<string | null> {
  if (input.overpaymentRecognisedMinor <= 0n || input.overpayTreatment !== "AUTO_REFUND") return null;

  // The most recent APPLIED allocation against this assessment names the
  // payment the surplus is refunded from — a defensible, disclosed choice
  // where several payments could in principle share one assessment.
  const mostRecentAllocation = await db
    .selectFrom("payment_allocation")
    .select("payment_id")
    .where("assessment_id", "=", input.assessmentId)
    .where("status", "=", "APPLIED")
    .orderBy("applied_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!mostRecentAllocation) return null;

  const result = await createRefund(
    db,
    { paymentId: mostRecentAllocation.payment_id, amountMinor: input.overpaymentRecognisedMinor, reasonCode: "ASSESSMENT_AMENDED", mode: "SURPLUS_ONLY", fundingSource: "PLATFORM_HELD", actorId: input.actorId },
    clock,
  );
  return result.refundId;
}
