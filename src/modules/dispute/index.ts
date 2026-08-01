import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";
import { getOrCreateLedgerAccount } from "../ledger/index.js";
import { postJournalTemplate } from "../journal-templates/index.js";

/**
 * §14.7 / §8.9: a card chargeback — the one rail in this platform where a
 * citizen can reverse a completed payment weeks later. Modelled as its own
 * narrow lifecycle (RECEIVED → EVIDENCE_SUBMITTED → WON/LOST), reusing the
 * existing `dispute` table (schema already carries everything needed —
 * no migration required) and the existing `CHARGEBACK_DEBITED` (T22) journal
 * template, which until now was defined but never actually posted by any
 * code path.
 */

export interface CreateDisputeInput {
  paymentId: string;
  schemeReasonCode: string;
  amountMinor: bigint;
  representmentDeadline?: string;
}

export async function receiveDispute(db: Kysely<Database>, input: CreateDisputeInput, clock: Clock): Promise<{ disputeId: string }> {
  return db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("dispute")
      .values({
        payment_id: input.paymentId,
        scheme_reason_code: input.schemeReasonCode,
        amount_minor: input.amountMinor,
        status: "RECEIVED",
        representment_deadline: input.representmentDeadline ?? null,
        created_at: clock.now(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await appendAuditEntry(trx, { actorType: "INSTITUTION", actorId: "card-scheme", action: "dispute.received", entityType: "dispute", entityId: inserted.id, afterJson: { paymentId: input.paymentId, schemeReasonCode: input.schemeReasonCode, amountMinor: input.amountMinor.toString() } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "dispute", aggregateId: inserted.id, sequence: 1, eventType: "dispute.received", payload: { disputeId: inserted.id, paymentId: input.paymentId } }, clock);

    return { disputeId: inserted.id };
  });
}

/**
 * §14.7's own instruction: the strongest representment evidence in this
 * domain is proof the government service was actually delivered. Assembles
 * the receipt, the payment's full application trace, and the settled
 * assessment(s) it discharged — real data pulled together, not a fabricated
 * bundle — and moves the dispute to EVIDENCE_SUBMITTED.
 */
export async function assembleEvidenceBundle(db: Kysely<Database>, disputeId: string, clock: Clock): Promise<Record<string, unknown>> {
  return db.transaction().execute(async (trx: Transaction<Database>) => {
    const dispute = await trx.selectFrom("dispute").selectAll().where("id", "=", disputeId).executeTakeFirstOrThrow();
    const payment = await trx.selectFrom("payment").selectAll().where("id", "=", dispute.payment_id).executeTakeFirstOrThrow();
    const receipt = await trx.selectFrom("receipt").select(["receipt_no", "status", "business_date"]).where("payment_id", "=", dispute.payment_id).executeTakeFirst();
    const allocations = await trx
      .selectFrom("payment_allocation")
      .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
      .select(["assessment.psid", "assessment.status", "payment_allocation.amount_minor"])
      .where("payment_allocation.payment_id", "=", dispute.payment_id)
      .execute();

    const bundle = {
      receipt: receipt ? { receiptNo: receipt.receipt_no, status: receipt.status, businessDate: receipt.business_date } : null,
      applicationTrace: payment.application_trace,
      settledObligations: allocations.map((a) => ({ psid: a.psid, status: a.status, amountMinor: a.amount_minor.toString() })),
      channel: payment.channel,
      rail: payment.rail,
      valueDate: payment.value_date,
    };

    await trx.updateTable("dispute").set({ status: "EVIDENCE_SUBMITTED", evidence_bundle: JSON.stringify(bundle) as never }).where("id", "=", disputeId).execute();
    await appendAuditEntry(trx, { actorType: "SYSTEM", actorId: "dispute-engine", action: "dispute.evidence_submitted", entityType: "dispute", entityId: disputeId, beforeJson: { status: "RECEIVED" }, afterJson: { status: "EVIDENCE_SUBMITTED" } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "dispute", aggregateId: disputeId, sequence: 2, eventType: "dispute.evidence_submitted", payload: { disputeId } }, clock);

    return bundle;
  });
}

export type DisputeOutcome = "WON" | "LOST";
export type DisputeLiability = "OPERATOR" | "AGENCY" | "SHARED";

/**
 * WON: the representment succeeded — no money moves, the payment stands.
 * LOST: the scheme claws the money back. Posts the existing CHARGEBACK_DEBITED
 * (T22) template — Dr Agency Payable / Cr Card Acquirer Receivable — and
 * records who actually bears the liability (configurable, never assumed),
 * so it appears in the agency's own statement rather than being buried
 * inside a payment record (§14.7's own instruction).
 */
export async function resolveDispute(db: Kysely<Database>, disputeId: string, outcome: DisputeOutcome, liability: DisputeLiability, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const dispute = await trx.selectFrom("dispute").selectAll().where("id", "=", disputeId).executeTakeFirstOrThrow();
    if (dispute.status !== "EVIDENCE_SUBMITTED" && dispute.status !== "RECEIVED") {
      throw new Error(`Dispute ${disputeId} already resolved (status ${dispute.status})`);
    }
    const payment = await trx.selectFrom("payment").selectAll().where("id", "=", dispute.payment_id).executeTakeFirstOrThrow();

    if (outcome === "LOST" && payment.agency_id) {
      const agencyCode = (await trx.selectFrom("agency").select("code").where("id", "=", payment.agency_id).executeTakeFirstOrThrow()).code;
      const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: agencyCode, name: "Agency Payable", accountType: "LIABILITY", normalBalance: "CR", agencyId: payment.agency_id });
      const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "1300", dimensionKey: "CARD", name: "Card Acquirer Receivable", accountType: "ASSET", normalBalance: "DR" });
      await postJournalTemplate(trx, { eventType: "CHARGEBACK_DEBITED", debitAccountCode: debitCode, creditAccountCode: creditCode, amountMinor: dispute.amount_minor, sourceType: "dispute", sourceId: disputeId, agencyId: payment.agency_id, valueDate: payment.value_date, narrative: `Chargeback lost, liability: ${liability}` }, clock);
    }

    const newStatus = outcome === "WON" ? "WON" : "LOST";
    await trx.updateTable("dispute").set({ status: newStatus, liability, resolved_at: clock.now() }).where("id", "=", disputeId).execute();
    await appendAuditEntry(trx, { actorType: "USER", actorId: "dispute-ops", action: `dispute.${outcome.toLowerCase()}`, entityType: "dispute", entityId: disputeId, beforeJson: { status: dispute.status }, afterJson: { status: newStatus, liability } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "dispute", aggregateId: disputeId, sequence: 3, eventType: `dispute.${outcome.toLowerCase()}`, payload: { disputeId, liability } }, clock);
  });
}
