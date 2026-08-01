import { randomUUID, randomBytes } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { verifyResolutionToken } from "../../platform/resolution-token/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";
import { applyWaterfall, decideAssessmentOutcome, type OpenLine, type ExplicitInstruction, type Waterfall } from "../allocation/index.js";
import { getOrCreateLedgerAccount, postJournalEntry } from "../ledger/index.js";
import { parseNarrative } from "../resolution/narrative-parser.js";
import { mintReceiptForPayment } from "../evidence/receipt.js";
import { detectProbableDuplicate } from "../refund/duplicate-detection.js";

/**
 * §11.1's apply pipeline, all 8 steps: identify → deduplicate → derive
 * targets → validate → allocate → handle residual → post → evidence. Every
 * step idempotent; the whole thing replayable from the payment record via
 * `application_trace` (§11.1's own closing instruction).
 *
 * §8.4/§14.5's governing rule threads through every branch here: **always
 * accept money that has already left the payer's account.** Nothing in this
 * module ever rejects a credit — the worst outcome for a real credit is
 * "unapplied, flagged, and refundable later," never "returned to sender."
 */

export class ResolutionTokenInvalidError extends Error {
  readonly httpStatus = 401;
  readonly code = "RESOLUTION_TOKEN_INVALID";
  constructor(reason: string) {
    super(`resolution_token is invalid or expired: ${reason}`);
    this.name = "ResolutionTokenInvalidError";
  }
}

/** §14.5 hard tier: "reject as a duplicate; return the original's response.
 * Not a payment at all." — enforced structurally by §6.8's UNIQUE indexes;
 * this is the typed signal `capturePayment` throws so the caller can look up
 * and return the original payment's own outcome instead. */
export class HardDuplicatePaymentError extends Error {
  readonly code = "DUPLICATE_PAYMENT";
  constructor(public readonly conflictField: "rail_e2e_id" | "switch" | "intent" | "instrument") {
    super(`Hard duplicate on ${conflictField} — not a new payment, return the original's response`);
    this.name = "HardDuplicatePaymentError";
  }
}

function generateReference(prefix: string): string {
  return `${prefix}${randomBytes(6).toString("hex").toUpperCase()}`;
}

export interface CreatePaymentIntentInput {
  channel: string;
  payerId?: string;
  resolutionToken: string;
  institutionId: string;
}

/** Binds a Phase-1 `resolution_token` into a real intent — the amounts a
 * payer was quoted become the amounts this intent expects. Fee/tax-on-fee
 * computation needs a `fee_schedule` engine that doesn't exist in this build
 * (no product in demo-data configures one) — both stay 0, disclosed rather
 * than invented, so `total_debit_minor` is exactly the sum of the quoted payables. */
export async function createPaymentIntent(db: Kysely<Database>, input: CreatePaymentIntentInput, clock: Clock): Promise<{ id: string; intentReference: string }> {
  const verification = await verifyResolutionToken(input.resolutionToken, clock);
  if (!verification.valid) throw new ResolutionTokenInvalidError(verification.reason);

  const totalMinor = verification.claims.payables.reduce((s, p) => s + BigInt(p.amountMinor), 0n);
  const intentReference = generateReference("IP");
  const quoteExpiresAt = new Date(clock.now().getTime() + 5 * 60 * 1000);

  const inserted = await db
    .insertInto("payment_intent")
    .values({
      intent_reference: intentReference,
      channel: input.channel,
      initiating_institution_id: input.institutionId,
      payer_id: input.payerId ?? null,
      requested_amount_minor: totalMinor,
      total_debit_minor: totalMinor,
      requested_allocations: JSON.stringify(verification.claims.payables) as never,
      quote_expires_at: quoteExpiresAt,
      status: "CREATED",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  return { id: inserted.id, intentReference };
}

export interface ExplicitAllocationInput {
  psid: string;
  lineType?: string;
  revenueHeadCode?: string;
  amountMinor: bigint;
}

export interface CapturePaymentInput {
  paymentReference: string;
  intentReference?: string;
  channel: string;
  rail: "RAAST" | "IBFT_1LINK" | "PRISM_RTGS" | "PAYPAK" | "CARD_SCHEME" | "INTERNAL_BOOK" | "CASH" | "CHEQUE_CLEARING" | "WALLET";
  grossAmountMinor: bigint;
  currency?: string;
  valueDate: string;
  obligationDischargeDate: string;
  remittanceRaw?: string;
  explicitAllocations?: readonly ExplicitAllocationInput[];
  payerId?: string;
  payerAccountMasked?: string;
  payerBankBic?: string;
  railE2eId?: string;
  switchStan?: string;
  switchRrn?: string;
  acquirerId?: string;
  instrumentId?: string;
  /** No real rail exists to call in this demo — the caller (a test, or a
   * simulated webhook) states what the capture attempt resolved to. Real
   * production code would get this from the rail's own response; §9.4's
   * `UNCERTAIN` rule ("any capture attempt that does not return a definite
   * success or failure lands in UNCERTAIN — never guess") is honoured by
   * defaulting here to `UNCERTAIN` whenever the caller doesn't affirmatively
   * assert `CONFIRMED`. */
  captureOutcome?: "CONFIRMED" | "UNCERTAIN" | "FAILED";
}

export interface CapturePaymentResult {
  paymentId: string;
  status: "CONFIRMED" | "UNCERTAIN" | "FAILED";
  applicationTrace: Record<string, unknown>;
  settledAssessmentIds: string[];
  unappliedAmountMinor: bigint;
}

interface AssessmentContext {
  id: string;
  psid: string;
  agencyId: string;
  agencyCode: string;
  currency: string;
  status: string;
  payableAmountMinor: bigint;
  productId: string;
  waterfall: Waterfall;
  allowPartial: boolean;
  underpayPolicy: "HOLD_AS_UNAPPLIED" | "REJECT_AND_RETURN";
  underpayToleranceMinor: bigint;
  overpayToleranceMinor: bigint;
  overpayTreatment: "REJECT" | "CREDIT_ON_ACCOUNT" | "AUTO_REFUND" | "ABSORB";
}

async function loadAssessmentContext(db: Kysely<Database>, assessmentId: string): Promise<AssessmentContext> {
  const row = await db
    .selectFrom("assessment")
    .innerJoin("agency", "agency.id", "assessment.agency_id")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .select([
      "assessment.id", "assessment.psid", "assessment.agency_id", "assessment.currency", "assessment.status", "assessment.payable_amount_minor", "assessment.product_id",
      "agency.code as agency_code",
      "collection_product.allocation_waterfall", "collection_product.allow_partial", "collection_product.underpay_policy",
      "collection_product.underpay_tolerance_minor", "collection_product.overpay_tolerance_minor", "collection_product.overpay_treatment",
    ])
    .where("assessment.id", "=", assessmentId)
    .executeTakeFirstOrThrow();
  return {
    id: row.id, psid: row.psid, agencyId: row.agency_id, agencyCode: row.agency_code, currency: row.currency, status: row.status,
    payableAmountMinor: row.payable_amount_minor, productId: row.product_id, waterfall: row.allocation_waterfall,
    allowPartial: row.allow_partial, underpayPolicy: row.underpay_policy, underpayToleranceMinor: row.underpay_tolerance_minor,
    overpayToleranceMinor: row.overpay_tolerance_minor, overpayTreatment: row.overpay_treatment,
  };
}

async function loadOpenLines(db: Kysely<Database>, assessmentId: string): Promise<OpenLine[]> {
  const rows = await db
    .selectFrom("assessment_line_item")
    .select(["id", "assessment_id", "line_type", "tax_period", "allocation_priority", "amount_minor", "allocated_minor"])
    .where("assessment_id", "=", assessmentId)
    .execute();
  return rows
    .map((r) => ({ lineItemId: r.id, assessmentId: r.assessment_id, lineType: r.line_type, taxPeriod: r.tax_period, allocationPriority: r.allocation_priority, balanceMinor: r.amount_minor - r.allocated_minor }))
    .filter((l) => l.balanceMinor > 0n);
}

interface RunAllocationParams {
  rail: CapturePaymentInput["rail"];
  valueDate: string;
  grossAmountMinor: bigint;
  explicitAllocations?: readonly ExplicitAllocationInput[];
  intent?: { id: string; requested_allocations: unknown } | undefined;
  remittanceRaw?: string;
  payerId?: string;
}

interface RunAllocationResult {
  unappliedAmountMinor: bigint;
  settledAssessmentIds: string[];
  journalPostings: { assessmentId: string; agencyId: string; agencyCode: string; amountMinor: bigint }[];
  derivationMethod: string;
  candidateAssessmentIds: string[];
}

/** Steps 3-7 (derive targets → validate → allocate → handle residual → post)
 * — factored out so both a fresh capture (`capturePayment`) and a resolved
 * `UNCERTAIN` payment (`resolveUncertainPayment`, once the resolver strategy
 * confirms it was actually paid) run the exact same allocation logic rather
 * than a second, drifting copy of it. */
async function runAllocation(trx: Transaction<Database>, paymentId: string, params: RunAllocationParams, clock: Clock): Promise<RunAllocationResult> {
  let candidateAssessmentIds: string[] = [];
  const explicitInstructionsByAssessment = new Map<string, ExplicitInstruction[]>();
  let derivationMethod = "NONE";

  if (params.explicitAllocations && params.explicitAllocations.length > 0) {
    derivationMethod = "EXPLICIT";
    for (const alloc of params.explicitAllocations) {
      const assessment = await trx.selectFrom("assessment").select("id").where("psid", "=", alloc.psid).executeTakeFirst();
      if (!assessment) continue;
      if (!candidateAssessmentIds.includes(assessment.id)) candidateAssessmentIds.push(assessment.id);
      if (alloc.lineType && alloc.revenueHeadCode) {
        const line = await trx
          .selectFrom("assessment_line_item")
          .innerJoin("revenue_head", "revenue_head.id", "assessment_line_item.revenue_head_id")
          .select("assessment_line_item.id")
          .where("assessment_line_item.assessment_id", "=", assessment.id)
          .where("assessment_line_item.line_type", "=", alloc.lineType as never)
          .where("revenue_head.code", "=", alloc.revenueHeadCode)
          .executeTakeFirst();
        if (line) {
          const list = explicitInstructionsByAssessment.get(assessment.id) ?? [];
          list.push({ lineItemId: line.id, amountMinor: alloc.amountMinor });
          explicitInstructionsByAssessment.set(assessment.id, list);
        }
      }
    }
  } else if (params.intent?.requested_allocations) {
    derivationMethod = "INTENT_PAYABLE_SET";
    const payables = params.intent.requested_allocations as unknown as { psid: string }[];
    for (const p of payables) {
      const assessment = await trx.selectFrom("assessment").select("id").where("psid", "=", p.psid).executeTakeFirst();
      if (assessment) candidateAssessmentIds.push(assessment.id);
    }
  } else if (params.remittanceRaw) {
    const parsed = await parseNarrative(trx, { narrative: params.remittanceRaw, grossAmountMinor: params.grossAmountMinor, ...(params.payerId ? { payerId: params.payerId } : {}) });
    if (parsed.outcome.kind === "AUTO_APPLY") {
      derivationMethod = `NARRATIVE_${parsed.outcome.method}`;
      candidateAssessmentIds = [parsed.outcome.assessmentId];
    }
  }

  let unappliedAmountMinor = params.grossAmountMinor;
  const settledAssessmentIds: string[] = [];
  const journalPostings: { assessmentId: string; agencyId: string; agencyCode: string; amountMinor: bigint }[] = [];

  if (candidateAssessmentIds.length === 0) {
    const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: "1150", dimensionKey: params.rail, name: "Rail Settlement Receivable", accountType: "ASSET", normalBalance: "DR" });
    const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "2020", dimensionKey: "PLATFORM", name: "Unapplied Receipts", accountType: "LIABILITY", normalBalance: "CR" });
    await postJournalEntry(trx, { eventType: "RECEIPT_UNAPPLIED", sourceType: "payment", sourceId: paymentId, valueDate: params.valueDate, lines: [
      { seq: 1, accountCode: debitCode, direction: "DR", amountMinor: params.grossAmountMinor },
      { seq: 2, accountCode: creditCode, direction: "CR", amountMinor: params.grossAmountMinor },
    ] }, clock);
    return { unappliedAmountMinor, settledAssessmentIds, journalPostings, derivationMethod, candidateAssessmentIds };
  }

  let remainingForWaterfall = params.grossAmountMinor;
  for (const assessmentId of candidateAssessmentIds) {
    if (remainingForWaterfall <= 0n) break;
    const ctx = await loadAssessmentContext(trx, assessmentId);
    const isOpen = ["ISSUED", "PARTIALLY_PAID", "OVERDUE"].includes(ctx.status);
    if (!isOpen) continue;

    const openLines = await loadOpenLines(trx, assessmentId);
    const explicitForThis = explicitInstructionsByAssessment.get(assessmentId) ?? [];
    const { allocations, remainingMinor } = applyWaterfall(ctx.waterfall, explicitForThis, openLines, remainingForWaterfall);
    if (allocations.length === 0) continue;

    const allocatedTotal = allocations.reduce((s, a) => s + a.amountMinor, 0n);

    // §11.4's decision is made on the HYPOTHETICAL post-allocation total
    // before anything is written — HOLD_AS_UNAPPLIED/REJECT_AND_RETURN mean
    // this money never actually lands on the line items at all ("never
    // silently keep money against an unsettled bill with no record"); only
    // SETTLED/PARTIALLY_PAID/OVERPAID actually commit the allocation.
    const currentAssessmentRow = await trx.selectFrom("assessment").select("allocated_amount_minor").where("id", "=", assessmentId).executeTakeFirstOrThrow();
    const decision = decideAssessmentOutcome({
      payableAmountMinor: ctx.payableAmountMinor,
      allocatedAfterMinor: currentAssessmentRow.allocated_amount_minor + allocatedTotal,
      underpayToleranceMinor: ctx.underpayToleranceMinor, overpayToleranceMinor: ctx.overpayToleranceMinor,
      allowPartial: ctx.allowPartial, underpayPolicy: ctx.underpayPolicy, overpayTreatment: ctx.overpayTreatment,
    });

    if (decision.kind === "HOLD_AS_UNAPPLIED" || decision.kind === "REJECT_AND_RETURN") {
      // This candidate's share of the money stays unapplied; don't consume it
      // from remainingForWaterfall either, so a later candidate (if any) or
      // the final unapplied posting gets it instead.
      continue;
    }

    remainingForWaterfall = derivationMethod === "EXPLICIT" ? remainingMinor : remainingForWaterfall - allocatedTotal;
    unappliedAmountMinor -= allocatedTotal;

    for (const alloc of allocations) {
      const lineItem = await trx.selectFrom("assessment_line_item").select("revenue_head_id").where("id", "=", alloc.lineItemId).executeTakeFirstOrThrow();
      await trx.insertInto("payment_allocation").values({ payment_id: paymentId, assessment_id: assessmentId, line_item_id: alloc.lineItemId, revenue_head_id: lineItem.revenue_head_id, amount_minor: alloc.amountMinor, allocation_basis: alloc.basis }).execute();
      await trx.updateTable("assessment_line_item").set((eb) => ({ allocated_minor: eb("allocated_minor", "+", alloc.amountMinor) })).where("id", "=", alloc.lineItemId).execute();
    }
    await trx.updateTable("assessment").set((eb) => ({ allocated_amount_minor: eb("allocated_amount_minor", "+", allocatedTotal), balance_minor: eb("balance_minor", "-", allocatedTotal) })).where("id", "=", assessmentId).execute();

    if (decision.kind === "SETTLED") {
      if (decision.roundingReliefMinor > 0n) {
        const roundingHead = await trx.selectFrom("collection_product").select("default_revenue_head_id").where("id", "=", ctx.productId).executeTakeFirstOrThrow();
        await trx.insertInto("assessment_line_item").values({ assessment_id: assessmentId, seq: 999, line_type: "ROUNDING", revenue_head_id: roundingHead.default_revenue_head_id, amount_minor: -decision.roundingReliefMinor, allocated_minor: -decision.roundingReliefMinor }).execute();
        await trx.updateTable("assessment").set((eb) => ({ assessed_amount_minor: eb("assessed_amount_minor", "-", decision.roundingReliefMinor), payable_amount_minor: eb("payable_amount_minor", "-", decision.roundingReliefMinor), balance_minor: sql<bigint>`0` })).where("id", "=", assessmentId).execute();
      }
      await trx.updateTable("assessment").set({ status: "SETTLED" }).where("id", "=", assessmentId).execute();
      settledAssessmentIds.push(assessmentId);
    } else if (decision.kind === "PARTIALLY_PAID") {
      await trx.updateTable("assessment").set({ status: "PARTIALLY_PAID" }).where("id", "=", assessmentId).execute();
    } else if (decision.kind === "OVERPAID") {
      // The bill itself is fully discharged (paid in full, plus a surplus) —
      // §14.2's overpayment recognition is about what happens to the EXTRA
      // money, not whether the assessment is settled. The surplus's actual
      // disposition (credit-on-account / auto-refund / reject-whole-payment)
      // needs Phase 5's treasury/refund engine — recorded, not built ahead.
      await trx.updateTable("assessment").set({ status: "SETTLED" }).where("id", "=", assessmentId).execute();
      settledAssessmentIds.push(assessmentId);
    }
    // HOLD_AS_UNAPPLIED / REJECT_AND_RETURN: money that couldn't settle the
    // bill stays on the payment as unapplied — no assessment status change.

    journalPostings.push({ assessmentId, agencyId: ctx.agencyId, agencyCode: ctx.agencyCode, amountMinor: allocatedTotal });
  }

  // Each posting here shares one payment's sourceId and (for a single-rail
  // capture) one eventType — postJournalEntry's idempotency key is
  // (source_type, source_id, event_type, sequence), so when ONE payment
  // settles MULTIPLE assessments (e.g. one cheque paying three separate
  // PSIDs), every posting after the first would silently collide with
  // sequence's implicit default of 1 and be dropped as a "replay" instead of
  // actually posting. An explicit per-posting sequence keeps each assessment's
  // credit genuinely distinct.
  for (const [i, posting] of journalPostings.entries()) {
    const debitBaseCode = params.rail === "CASH" ? "1010" : params.rail === "CHEQUE_CLEARING" ? "1030" : "1150";
    const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: debitBaseCode, dimensionKey: params.rail, name: "Collection Receivable", accountType: "ASSET", normalBalance: "DR" });
    const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: posting.agencyCode, name: "Agency Payable", accountType: "LIABILITY", normalBalance: "CR", agencyId: posting.agencyId });
    await postJournalEntry(trx, {
      eventType: params.rail === "CASH" ? "COLLECT_CASH_OTC" : "COLLECT_RAIL_CONFIRMED",
      sourceType: "payment", sourceId: paymentId, sequence: i + 1, agencyId: posting.agencyId, valueDate: params.valueDate,
      lines: [
        { seq: 1, accountCode: debitCode, direction: "DR", amountMinor: posting.amountMinor },
        { seq: 2, accountCode: creditCode, direction: "CR", amountMinor: posting.amountMinor },
      ],
    }, clock);
  }

  if (unappliedAmountMinor > 0n) {
    const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: "1150", dimensionKey: params.rail, name: "Rail Settlement Receivable", accountType: "ASSET", normalBalance: "DR" });
    const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "2020", dimensionKey: "PLATFORM", name: "Unapplied Receipts", accountType: "LIABILITY", normalBalance: "CR" });
    await postJournalEntry(trx, { eventType: "RECEIPT_UNAPPLIED", sourceType: "payment", sourceId: paymentId, sequence: 2, valueDate: params.valueDate, lines: [
      { seq: 1, accountCode: debitCode, direction: "DR", amountMinor: unappliedAmountMinor },
      { seq: 2, accountCode: creditCode, direction: "CR", amountMinor: unappliedAmountMinor },
    ] }, clock);
  }

  return { unappliedAmountMinor, settledAssessmentIds, journalPostings, derivationMethod, candidateAssessmentIds };
}

/** The 8-step apply pipeline (§11.1). Runs inside one transaction —
 * identification through evidence, atomically. */
export async function capturePayment(db: Kysely<Database>, input: CapturePaymentInput, clock: Clock): Promise<CapturePaymentResult> {
  return db.transaction().execute(async (trx: Transaction<Database>) => {
    // --- Step 2: DEDUPLICATE (§14.5) — hard tier first, structurally, before
    // touching anything else. A hard duplicate throws; the caller is
    // responsible for returning the original payment's own response (never a
    // rejection of the money itself — the ORIGINAL payment already accepted it).
    if (input.railE2eId) {
      const dupe = await trx.selectFrom("payment").select("id").where("rail", "=", input.rail).where("rail_e2e_id", "=", input.railE2eId).executeTakeFirst();
      if (dupe) throw new HardDuplicatePaymentError("rail_e2e_id");
    }
    if (input.switchStan && input.switchRrn && input.acquirerId) {
      const dupe = await trx.selectFrom("payment").select("id").where("acquirer_id", "=", input.acquirerId).where("switch_stan", "=", input.switchStan).where("switch_rrn", "=", input.switchRrn).where("value_date", "=", input.valueDate).executeTakeFirst();
      if (dupe) throw new HardDuplicatePaymentError("switch");
    }

    // --- Step 1: IDENTIFY ---
    const intent = input.intentReference
      ? await trx.selectFrom("payment_intent").selectAll().where("intent_reference", "=", input.intentReference).executeTakeFirst()
      : undefined;

    const captureOutcome = input.captureOutcome ?? "UNCERTAIN";
    const paymentReference = input.paymentReference || generateReference("PM");

    // §9.3/§8.4: a credit against an EXPIRED/FAILED intent still applies —
    // "expiry governs the quote, not the money" — so intent staleness never
    // blocks capture; it only affects which intent status this payment leaves behind.
    const lateIntent = intent !== undefined && (intent.status === "EXPIRED" || intent.status === "FAILED");

    const paymentId = randomUUID();
    const trace: Record<string, unknown> = { steps: [] as unknown[] };
    const pushTrace = (step: string, detail: unknown) => (trace["steps"] as unknown[]).push({ step, detail });
    pushTrace("identify", { intentReference: input.intentReference ?? null, intentFound: Boolean(intent), lateIntent });

    if (captureOutcome !== "CONFIRMED") {
      // §9.4: never guess. Anything short of a definite success lands in
      // UNCERTAIN (or FAILED, if the caller asserts a definite rejection) —
      // no allocation happens yet; that's what the resolver does once it's confirmed.
      await trx
        .insertInto("payment")
        .values({
          id: paymentId, payment_reference: paymentReference, intent_id: intent?.id ?? null, channel: input.channel, rail: input.rail,
          gross_amount_minor: input.grossAmountMinor, net_to_agency_minor: input.grossAmountMinor, currency: input.currency ?? "PKR",
          status: captureOutcome, value_date: input.valueDate, obligation_discharge_date: input.obligationDischargeDate,
          ...(input.railE2eId ? { rail_e2e_id: input.railE2eId } : {}), ...(input.switchStan ? { switch_stan: input.switchStan } : {}),
          ...(input.switchRrn ? { switch_rrn: input.switchRrn } : {}), ...(input.acquirerId ? { acquirer_id: input.acquirerId } : {}),
          ...(input.instrumentId ? { instrument_id: input.instrumentId } : {}), ...(input.payerAccountMasked ? { payer_account_masked: input.payerAccountMasked } : {}),
          ...(input.payerBankBic ? { payer_bank_bic: input.payerBankBic } : {}), ...(input.remittanceRaw ? { remittance_raw: input.remittanceRaw } : {}),
          application_trace: JSON.stringify(trace) as never,
        })
        .execute();
      return { paymentId, status: captureOutcome, applicationTrace: trace, settledAssessmentIds: [], unappliedAmountMinor: 0n };
    }

    // `payment_allocation`/`journal_entry` both FK back to `payment`, so the row
    // must exist before Steps 3-7 can write anything — inserted first as
    // INITIATED, then updated to its final CONFIRMED shape once allocation
    // and posting (which need this id) have run.
    await trx
      .insertInto("payment")
      .values({
        id: paymentId, payment_reference: paymentReference, intent_id: intent?.id ?? null, channel: input.channel, rail: input.rail,
        gross_amount_minor: input.grossAmountMinor, net_to_agency_minor: input.grossAmountMinor, currency: input.currency ?? "PKR",
        status: "INITIATED", value_date: input.valueDate, obligation_discharge_date: input.obligationDischargeDate,
        ...(input.railE2eId ? { rail_e2e_id: input.railE2eId } : {}), ...(input.switchStan ? { switch_stan: input.switchStan } : {}),
        ...(input.switchRrn ? { switch_rrn: input.switchRrn } : {}), ...(input.acquirerId ? { acquirer_id: input.acquirerId } : {}),
        ...(input.instrumentId ? { instrument_id: input.instrumentId } : {}), ...(input.payerAccountMasked ? { payer_account_masked: input.payerAccountMasked } : {}),
        ...(input.payerBankBic ? { payer_bank_bic: input.payerBankBic } : {}), ...(input.remittanceRaw ? { remittance_raw: input.remittanceRaw } : {}),
      })
      .execute();

    // §14.5's "probable duplicate" tier — checked for the common single-PSID
    // explicit-allocation case (cheque cascade, switch adapter, direct API
    // captures): same assessment/amount/payer-account within 10 minutes of an
    // already-CONFIRMED payment. "Always accept the money... auto-create a
    // refund in PENDING_APPROVAL" — never allocate the second payment; it
    // falls through to the ordinary "no candidates" unapplied-receipt path
    // below, then a real refund is raised on top of it.
    let probableDuplicateOfPaymentId: string | null = null;
    let effectiveExplicitAllocations = input.explicitAllocations;
    if (input.explicitAllocations && input.explicitAllocations.length === 1 && input.payerAccountMasked) {
      const target = await trx.selectFrom("assessment").select("id").where("psid", "=", input.explicitAllocations[0]!.psid).executeTakeFirst();
      if (target) {
        const dup = await detectProbableDuplicate(trx, { assessmentId: target.id, grossAmountMinor: input.grossAmountMinor, payerAccountMasked: input.payerAccountMasked, nowIso: clock.now() });
        if (dup) {
          probableDuplicateOfPaymentId = dup.paymentId;
          effectiveExplicitAllocations = undefined;
        }
      }
    }

    // --- Steps 3-7: DERIVE TARGETS, VALIDATE, ALLOCATE, HANDLE RESIDUAL, POST ---
    const { unappliedAmountMinor, settledAssessmentIds, journalPostings, derivationMethod, candidateAssessmentIds } = await runAllocation(
      trx,
      paymentId,
      { rail: input.rail, valueDate: input.valueDate, grossAmountMinor: input.grossAmountMinor, ...(effectiveExplicitAllocations ? { explicitAllocations: effectiveExplicitAllocations } : {}), intent, ...(input.remittanceRaw ? { remittanceRaw: input.remittanceRaw } : {}), ...(input.payerId ? { payerId: input.payerId } : {}) },
      clock,
    );
    pushTrace("derive_targets", { method: probableDuplicateOfPaymentId ? "PROBABLE_DUPLICATE_UNAPPLIED" : derivationMethod, candidateAssessmentIds });

    await trx
      .updateTable("payment")
      .set({ agency_id: journalPostings[0]?.agencyId ?? null, unapplied_amount_minor: unappliedAmountMinor, status: "CONFIRMED", finality: "FINAL", confirmed_at: clock.now(), application_trace: JSON.stringify(trace) as never, ...(probableDuplicateOfPaymentId ? { duplicate_of_payment_id: probableDuplicateOfPaymentId } : {}) })
      .where("id", "=", paymentId)
      .execute();

    if (probableDuplicateOfPaymentId) {
      // §14.5: the money is accepted and recorded (T11 unapplied, above) —
      // now auto-create the refund rather than waiting for the payer to ask.
      const { createRefund } = await import("../refund/index.js");
      await createRefund(trx, { paymentId, amountMinor: input.grossAmountMinor, reasonCode: "DUPLICATE", mode: "SURPLUS_ONLY", fundingSource: "PLATFORM_HELD", actorId: "duplicate-detection" }, clock);
    }

    if (intent) {
      await trx.updateTable("payment_intent").set({ status: lateIntent ? "COMPLETED_LATE" : "COMPLETED" }).where("id", "=", intent.id).execute();
    }

    for (const assessmentId of settledAssessmentIds) {
      const ctx = journalPostings.find((p) => p.assessmentId === assessmentId);
      if (!ctx) continue;
      await mintReceiptForPayment(trx, { paymentId, agencyId: ctx.agencyId, agencyCode: ctx.agencyCode, businessDate: input.valueDate }, clock);
    }

    await appendAuditEntry(trx, { actorType: "SYSTEM", actorId: "apply-pipeline", action: "payment.captured", entityType: "payment", entityId: paymentId, beforeJson: null, afterJson: { status: "CONFIRMED", grossAmountMinor: input.grossAmountMinor.toString() } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "payment", aggregateId: paymentId, sequence: 1, eventType: "payment.captured", payload: { paymentId, paymentReference, grossAmountMinor: input.grossAmountMinor.toString(), settledAssessmentIds } }, clock);

    return { paymentId, status: "CONFIRMED", applicationTrace: trace, settledAssessmentIds, unappliedAmountMinor };
  });
}

/** Reverses every APPLIED allocation a payment made — un-settles affected
 * assessments, decrements their allocated/balance caches, reverses the
 * allocation rows (never deletes, §6.9), and posts `PAYMENT_REVERSED`. Used
 * directly by chargebacks/returns; the cheque-dishonour cascade (Phase 3)
 * builds on top of this same primitive rather than duplicating it. */
export async function reversePayment(db: Kysely<Database>, paymentId: string, reason: string, actor: { actorType: "USER" | "SERVICE" | "SYSTEM" | "INSTITUTION"; actorId: string }, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const payment = await trx.selectFrom("payment").selectAll().where("id", "=", paymentId).executeTakeFirstOrThrow();
    if (payment.status === "REVERSED") return; // already reversed — idempotent no-op

    const allocations = await trx.selectFrom("payment_allocation").selectAll().where("payment_id", "=", paymentId).where("status", "=", "APPLIED").execute();

    // §14.3 step 7: "once money has been swept to the treasury, the platform
    // cannot reverse it out — it becomes a receivable from the agency."
    // Checked per-allocation (Phase 4's runSweep tags each swept allocation
    // via swept_in_payment_id) rather than assumed from the payment as a
    // whole, since a payment can, in principle, span allocations swept on
    // different cycles.
    const anySwept = allocations.some((a) => a.swept_in_payment_id !== null);

    const affectedAssessmentIds = new Set<string>();
    for (const alloc of allocations) {
      await trx.updateTable("payment_allocation").set({ status: "REVERSED", reversed_at: clock.now(), reversal_reason: reason }).where("id", "=", alloc.id).execute();
      await trx.updateTable("assessment_line_item").set((eb) => ({ allocated_minor: eb("allocated_minor", "-", alloc.amount_minor) })).where("id", "=", alloc.line_item_id).execute();
      await trx.updateTable("assessment").set((eb) => ({ allocated_amount_minor: eb("allocated_amount_minor", "-", alloc.amount_minor), balance_minor: eb("balance_minor", "+", alloc.amount_minor) })).where("id", "=", alloc.assessment_id).execute();
      affectedAssessmentIds.add(alloc.assessment_id);
    }

    for (const assessmentId of affectedAssessmentIds) {
      const assessment = await trx.selectFrom("assessment").selectAll().where("id", "=", assessmentId).executeTakeFirstOrThrow();
      const newStatus = assessment.allocated_amount_minor <= 0n ? "ISSUED" : "PARTIALLY_PAID";
      await trx.updateTable("assessment").set({ status: newStatus }).where("id", "=", assessmentId).execute();
    }

    if (payment.agency_id && payment.gross_amount_minor > 0n) {
      const agencyCode = (await trx.selectFrom("agency").select("code").where("id", "=", payment.agency_id).executeTakeFirstOrThrow()).code;
      // Mirror capturePayment's own rail→base-code mapping exactly, so the
      // reversal credits back the SAME receivable account the capture
      // originally debited (CASH→1010, CHEQUE_CLEARING→1030, else 1150).
      const railBaseCode = payment.rail === "CASH" ? "1010" : payment.rail === "CHEQUE_CLEARING" ? "1030" : "1150";
      if (anySwept) {
        // Not a silent undo: 2010 was already relieved by the sweep, so this
        // is a NEW receivable from the agency, not a reversal of the
        // original collection entry.
        const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: "2070", dimensionKey: agencyCode, name: "Receivable from Agency (Post-Sweep Recovery)", accountType: "ASSET", normalBalance: "DR", agencyId: payment.agency_id });
        const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: railBaseCode, dimensionKey: payment.rail, name: "Collection Receivable", accountType: "ASSET", normalBalance: "DR" });
        await postJournalEntry(trx, { eventType: "PAYMENT_REVERSED", sourceType: "payment", sourceId: paymentId, sequence: 3, agencyId: payment.agency_id, valueDate: payment.value_date, narrative: `${reason} (post-sweep recovery)`, lines: [
          { seq: 1, accountCode: debitCode, direction: "DR", amountMinor: payment.gross_amount_minor },
          { seq: 2, accountCode: creditCode, direction: "CR", amountMinor: payment.gross_amount_minor },
        ] }, clock);
      } else {
        const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: agencyCode, name: "Agency Payable", accountType: "LIABILITY", normalBalance: "CR", agencyId: payment.agency_id });
        const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: railBaseCode, dimensionKey: payment.rail, name: "Collection Receivable", accountType: "ASSET", normalBalance: "DR" });
        await postJournalEntry(trx, { eventType: "PAYMENT_REVERSED", sourceType: "payment", sourceId: paymentId, sequence: 3, agencyId: payment.agency_id, valueDate: payment.value_date, narrative: reason, lines: [
          { seq: 1, accountCode: debitCode, direction: "DR", amountMinor: payment.gross_amount_minor },
          { seq: 2, accountCode: creditCode, direction: "CR", amountMinor: payment.gross_amount_minor },
        ] }, clock);
      }
    }

    await trx.updateTable("payment").set({ status: "REVERSED" }).where("id", "=", paymentId).execute();

    await appendAuditEntry(trx, { actorType: actor.actorType, actorId: actor.actorId, action: "payment.reversed", entityType: "payment", entityId: paymentId, beforeJson: { status: payment.status }, afterJson: { status: "REVERSED", reason } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "payment", aggregateId: paymentId, sequence: 3, eventType: "payment.reversed", payload: { paymentId, reason } }, clock);
  });
}

export interface UncertainResolution {
  outcome: "FOUND_PAID" | "FOUND_NOT_PAID" | "STILL_UNRESOLVED";
  source: "RAIL_STATUS_ENQUIRY" | "AGGREGATOR_ADVICE" | "INTRADAY_STATEMENT" | "EOD_STATEMENT" | "HUMAN_INVESTIGATION";
}

/** §9.4's resolver: escalates through 5 strategies against a real rail/
 * statement integration in production; here the caller supplies what that
 * strategy found (no real rail exists in this demo to poll), and this
 * function only owns the resulting state transition — real state-machine
 * mechanics, a stubbed upstream, disclosed rather than faked as live. */
export async function resolveUncertainPayment(db: Kysely<Database>, paymentId: string, resolution: UncertainResolution, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const payment = await trx.selectFrom("payment").selectAll().where("id", "=", paymentId).executeTakeFirstOrThrow();
    if (payment.status !== "UNCERTAIN") {
      throw new Error(`Cannot resolve payment ${paymentId}: not UNCERTAIN (currently ${payment.status})`);
    }

    if (resolution.outcome === "STILL_UNRESOLVED") {
      await trx.updateTable("payment").set({ uncertain_resolution_source: resolution.source }).where("id", "=", paymentId).execute();
      return;
    }

    const newStatus = resolution.outcome === "FOUND_PAID" ? "CONFIRMED" : "FAILED";

    let settledAssessmentIds: string[] = [];
    if (newStatus === "CONFIRMED") {
      // Found to have actually been paid: run the SAME allocation logic a
      // fresh confirmed capture would (§9.4 doesn't leave a found-paid
      // payment sitting un-applied just because its confirmation was late).
      const intent = payment.intent_id ? await trx.selectFrom("payment_intent").selectAll().where("id", "=", payment.intent_id).executeTakeFirst() : undefined;
      const result = await runAllocation(
        trx,
        paymentId,
        {
          rail: payment.rail, valueDate: payment.value_date, grossAmountMinor: payment.gross_amount_minor,
          intent, ...(payment.remittance_raw ? { remittanceRaw: payment.remittance_raw } : {}),
        },
        clock,
      );
      settledAssessmentIds = result.settledAssessmentIds;
      await trx.updateTable("payment").set({ status: newStatus, uncertain_resolution_source: resolution.source, confirmed_at: clock.now(), unapplied_amount_minor: result.unappliedAmountMinor, agency_id: result.journalPostings[0]?.agencyId ?? null }).where("id", "=", paymentId).execute();
      if (intent) {
        const lateIntent = intent.status === "EXPIRED" || intent.status === "FAILED";
        await trx.updateTable("payment_intent").set({ status: lateIntent ? "COMPLETED_LATE" : "COMPLETED" }).where("id", "=", intent.id).execute();
      }
      for (const assessmentId of settledAssessmentIds) {
        const posting = result.journalPostings.find((p) => p.assessmentId === assessmentId);
        if (!posting) continue;
        await mintReceiptForPayment(trx, { paymentId, agencyId: posting.agencyId, agencyCode: posting.agencyCode, businessDate: payment.value_date }, clock);
      }
    } else {
      await trx.updateTable("payment").set({ status: newStatus, uncertain_resolution_source: resolution.source }).where("id", "=", paymentId).execute();
    }

    await appendAuditEntry(trx, { actorType: "SYSTEM", actorId: "uncertain-resolver", action: "payment.uncertain_resolved", entityType: "payment", entityId: paymentId, beforeJson: { status: "UNCERTAIN" }, afterJson: { status: newStatus, source: resolution.source, settledAssessmentIds } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "payment", aggregateId: paymentId, sequence: 2, eventType: "payment.uncertain_resolved", payload: { paymentId, newStatus, source: resolution.source } }, clock);
  });
}
