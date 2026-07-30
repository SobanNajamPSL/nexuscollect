import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";

/**
 * §16.1's receipt numbering: "Gapless per agency per day; {AGENCY}{YYYYMMDD}
 * {9-digit seq}; gaps are an audit finding, so allocate from a database
 * sequence, never from a counter in application memory." This module is the
 * minimal slice of §16 (a full Phase 5 deliverable) that Phase 1's resolve
 * endpoint needs: turning an assessment that's genuinely already been paid
 * (a real APPLIED payment_allocation exists) into a real receipt number,
 * rather than resolve returning a made-up string or nothing at all.
 */

// Serialises receipt numbering per (agency, business_date) so two concurrent
// mints for the same agency/day can't race to the same sequence number.
const RECEIPT_SEQ_LOCK_KEY = 727_100_003;

export interface ReceiptInfo {
  receiptNo: string;
  businessDate: string;
  status: "VALID" | "VOIDED" | "REFUNDED";
}

/**
 * Finds (or mints) the receipt for an assessment that has at least one
 * APPLIED payment_allocation. Returns null if the assessment genuinely has no
 * applied allocation yet (shouldn't happen for a truly SETTLED assessment,
 * but this is a read path — it must not throw on unexpected data).
 */
export async function ensureReceiptForSettledAssessment(
  db: Kysely<Database>,
  assessmentId: string,
  clock: Clock,
): Promise<ReceiptInfo | null> {
  return db.transaction().execute(async (trx: Transaction<Database>) => {
    const allocation = await trx
      .selectFrom("payment_allocation")
      .innerJoin("payment", "payment.id", "payment_allocation.payment_id")
      .select(["payment.id as payment_id", "payment.agency_id", "payment.value_date"])
      .where("payment_allocation.assessment_id", "=", assessmentId)
      .where("payment_allocation.status", "=", "APPLIED")
      .orderBy("payment_allocation.applied_at", "asc")
      .limit(1)
      .executeTakeFirst();

    if (!allocation || !allocation.agency_id) return null;

    const existing = await trx
      .selectFrom("receipt")
      .select(["receipt_no", "business_date", "status"])
      .where("payment_id", "=", allocation.payment_id)
      .executeTakeFirst();
    if (existing) {
      return { receiptNo: existing.receipt_no, businessDate: existing.business_date, status: existing.status };
    }

    await sql`SELECT pg_advisory_xact_lock(${RECEIPT_SEQ_LOCK_KEY})`.execute(trx);

    const agency = await trx
      .selectFrom("agency")
      .select("code")
      .where("id", "=", allocation.agency_id)
      .executeTakeFirstOrThrow();

    const dateCompact = allocation.value_date.replaceAll("-", "");
    const { count } = await trx
      .selectFrom("receipt")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("agency_id", "=", allocation.agency_id)
      .where("business_date", "=", allocation.value_date)
      .executeTakeFirstOrThrow();
    const nextSeq = Number(count) + 1;
    const receiptNo = `${agency.code}${dateCompact}${String(nextSeq).padStart(9, "0")}`;

    await trx
      .insertInto("receipt")
      .values({
        receipt_no: receiptNo,
        agency_id: allocation.agency_id,
        payment_id: allocation.payment_id,
        business_date: allocation.value_date,
        status: "VALID",
        issued_at: clock.now(),
      })
      .execute();

    return { receiptNo, businessDate: allocation.value_date, status: "VALID" };
  });
}
