import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";
import { getOrCreateLedgerAccount } from "../ledger/index.js";
import { postJournalTemplate } from "../journal-templates/index.js";

/**
 * §14.6: a refundable deposit (tender security, litigation deposit) sits in
 * account 2040 from the moment it's received (see `runAllocation`'s
 * `isRefundableDeposit` branch in `modules/payment`) and has exactly three
 * exits — refund, forfeit, or convert to revenue. Only the first two ledger
 * templates (T27 refund, T28 forfeit) exist in this build; "convert to
 * revenue" reuses T28's shape (2040 → 2010, becoming income) since that is
 * the true accounting effect of converting a held deposit to revenue —
 * distinguished only by its narrative and event reason, not a fabricated
 * fourth template.
 */

async function findDepositAllocation(db: Kysely<Database>, paymentId: string) {
  const allocation = await db
    .selectFrom("payment_allocation")
    .innerJoin("payment", "payment.id", "payment_allocation.payment_id")
    .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
    .select(["payment.id as payment_id", "payment.value_date", "payment.agency_id", "payment_allocation.amount_minor"])
    .where("payment_allocation.payment_id", "=", paymentId)
    .where("payment_allocation.status", "=", "APPLIED")
    .executeTakeFirstOrThrow();
  if (!allocation.agency_id) throw new Error(`Deposit payment ${paymentId} has no agency`);
  const agencyCode = (await db.selectFrom("agency").select("code").where("id", "=", allocation.agency_id).executeTakeFirstOrThrow()).code;
  return { ...allocation, agencyId: allocation.agency_id, agencyCode };
}

export async function refundDeposit(db: Kysely<Database>, paymentId: string, actorId: string, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const d = await findDepositAllocation(trx, paymentId);
    const depositCode = await getOrCreateLedgerAccount(trx, { baseCode: "2040", dimensionKey: d.agencyCode, name: "Refundable Deposits", accountType: "LIABILITY", normalBalance: "CR", agencyId: d.agencyId });
    const bankCode = await getOrCreateLedgerAccount(trx, { baseCode: "1100", dimensionKey: "PLATFORM", name: "Collection Bank", accountType: "ASSET", normalBalance: "DR" });
    await postJournalTemplate(trx, { eventType: "DEPOSIT_REFUNDED", debitAccountCode: depositCode, creditAccountCode: bankCode, amountMinor: d.amount_minor, sourceType: "payment", sourceId: paymentId, agencyId: d.agencyId, valueDate: d.value_date, narrative: "Deposit refunded to depositor" }, clock);
    await appendAuditEntry(trx, { actorType: "USER", actorId, action: "deposit.refunded", entityType: "payment", entityId: paymentId, afterJson: { amountMinor: d.amount_minor.toString() } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "payment", aggregateId: paymentId, sequence: 10, eventType: "deposit.refunded", payload: { paymentId } }, clock);
  });
}

export type DepositExit = "FORFEITED" | "CONVERTED_TO_REVENUE";

export async function exitDepositToRevenue(db: Kysely<Database>, paymentId: string, exit: DepositExit, actorId: string, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const d = await findDepositAllocation(trx, paymentId);
    const depositCode = await getOrCreateLedgerAccount(trx, { baseCode: "2040", dimensionKey: d.agencyCode, name: "Refundable Deposits", accountType: "LIABILITY", normalBalance: "CR", agencyId: d.agencyId });
    const agencyPayableCode = await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: d.agencyCode, name: "Agency Payable", accountType: "LIABILITY", normalBalance: "CR", agencyId: d.agencyId });
    await postJournalTemplate(trx, { eventType: "DEPOSIT_FORFEITED", debitAccountCode: depositCode, creditAccountCode: agencyPayableCode, amountMinor: d.amount_minor, sourceType: "payment", sourceId: paymentId, agencyId: d.agencyId, valueDate: d.value_date, narrative: exit === "FORFEITED" ? "Deposit forfeited" : "Deposit converted to revenue" }, clock);
    await appendAuditEntry(trx, { actorType: "USER", actorId, action: `deposit.${exit.toLowerCase()}`, entityType: "payment", entityId: paymentId, afterJson: { amountMinor: d.amount_minor.toString(), exit } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "payment", aggregateId: paymentId, sequence: 10, eventType: `deposit.${exit.toLowerCase()}`, payload: { paymentId, exit } }, clock);
  });
}
