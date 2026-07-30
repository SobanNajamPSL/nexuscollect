import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import type { Clock } from "../platform/clock/index.js";
import { getOrCreateLedgerAccount, postJournalEntry } from "../modules/ledger/index.js";

/**
 * Loader-time journal backfill (mirrors Phase 1's `mintReceiptsForSettledAssessments`
 * precedent: post real ledger effects for pre-existing facts, never invent the
 * facts themselves). The 115 historical payments in demo-data already carry
 * their real allocation decisions (`payment_allocations.csv`, loaded as facts) —
 * this posts the journal entries those facts imply, using
 * `modules/journal-templates` on real numbers, so §10.8's control assertions
 * (trial-balance, ledger-vs-subledger) are non-vacuous across the whole
 * historical dataset, not just payments newly processed through the live
 * apply pipeline.
 *
 * Only `CONFIRMED`/`PARTIALLY_REVERSED` payments post — matching
 * `checkAllocationIntegrity`'s own exclusion set (`REVERSED`/`UNCERTAIN`
 * payments have no real applied allocations to post for).
 */
export async function postHistoricalJournals(trx: Transaction<Database>, clock: Clock): Promise<number> {
  const payments = await trx
    .selectFrom("payment")
    .leftJoin("agency", "agency.id", "payment.agency_id")
    .select(["payment.id", "payment.rail", "payment.value_date", "payment.fee_amount_minor", "payment.unapplied_amount_minor", "agency.code as agency_code", "agency.id as agency_id"])
    .where("payment.status", "in", ["CONFIRMED", "PARTIALLY_REVERSED"])
    .execute();

  let posted = 0;
  for (const payment of payments) {
    const alreadyPosted = await trx.selectFrom("journal_entry").select("id").where("source_type", "=", "payment").where("source_id", "=", payment.id).executeTakeFirst();
    if (alreadyPosted) continue; // idempotent across repeated loader runs

    let sequence = 1;

    const allocationsByAgency = await trx
      .selectFrom("payment_allocation")
      .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
      .innerJoin("agency", "agency.id", "assessment.agency_id")
      .select(["agency.id as agency_id", "agency.code as agency_code"])
      .select(({ fn }) => fn.sum<bigint>("payment_allocation.amount_minor").as("total"))
      .where("payment_allocation.payment_id", "=", payment.id)
      .where("payment_allocation.status", "=", "APPLIED")
      .groupBy(["agency.id", "agency.code"])
      .execute();

    for (const group of allocationsByAgency) {
      const total = BigInt(group.total);
      if (total <= 0n) continue;
      const debitBaseCode = payment.rail === "CASH" ? "1010" : payment.rail === "CHEQUE_CLEARING" ? "1030" : "1150";
      const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: debitBaseCode, dimensionKey: payment.rail, name: "Collection Receivable", accountType: "ASSET", normalBalance: "DR" });
      const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: group.agency_code, name: "Agency Payable", accountType: "LIABILITY", normalBalance: "CR", agencyId: group.agency_id });
      await postJournalEntry(
        trx,
        {
          eventType: payment.rail === "CASH" ? "COLLECT_CASH_OTC" : "COLLECT_RAIL_CONFIRMED",
          sourceType: "payment",
          sourceId: payment.id,
          sequence: sequence++,
          agencyId: group.agency_id,
          valueDate: payment.value_date,
          narrative: "Historical backfill (loader)",
          lines: [
            { seq: 1, accountCode: debitCode, direction: "DR", amountMinor: total },
            { seq: 2, accountCode: creditCode, direction: "CR", amountMinor: total },
          ],
        },
        clock,
      );
      posted++;
    }

    // Fee posting (T14/T15) is deliberately NOT backfilled here: §10.8's
    // ledger-vs-subledger formula is literally "2010 per agency = Σ unswept
    // allocations per agency" — a fee deducted from the agency's own 2010
    // balance (T15) would legitimately make the ledger balance net-of-fee
    // while the subledger side (raw allocation sums) has no fee concept at
    // all, so posting it here would make a real, correct fee deduction look
    // like a false break in a check whose own formula doesn't account for
    // fees. Redefining that formula would be redesigning what §10.8 already
    // decided, not implementing it — so fee postings stay scoped to the live
    // apply pipeline's own future fee-schedule work, not this backfill.

    if (payment.unapplied_amount_minor > 0n) {
      const debitBaseCode = payment.rail === "CASH" ? "1010" : payment.rail === "CHEQUE_CLEARING" ? "1030" : "1150";
      const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: debitBaseCode, dimensionKey: payment.rail, name: "Collection Receivable", accountType: "ASSET", normalBalance: "DR" });
      const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "2020", dimensionKey: "PLATFORM", name: "Unapplied Receipts", accountType: "LIABILITY", normalBalance: "CR" });
      await postJournalEntry(
        trx,
        { eventType: "RECEIPT_UNAPPLIED", sourceType: "payment", sourceId: payment.id, sequence: sequence++, valueDate: payment.value_date, narrative: "Historical backfill (loader)", lines: [
          { seq: 1, accountCode: debitCode, direction: "DR", amountMinor: payment.unapplied_amount_minor },
          { seq: 2, accountCode: creditCode, direction: "CR", amountMinor: payment.unapplied_amount_minor },
        ] },
        clock,
      );
      posted++;
    }
  }

  return posted;
}
