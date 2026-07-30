import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";

/**
 * §16.1's receipt numbering: "Gapless per agency per day; {AGENCY}{YYYYMMDD}
 * {9-digit seq}; gaps are an audit finding, so allocate from a database
 * sequence, never from a counter in application memory." This module is the
 * minimal slice of §16 (a full Phase 5 deliverable) that Phase 1's resolve
 * endpoint needs.
 *
 * Finding K (audit): resolve must perform zero database writes. Receipts are
 * now minted exactly once, at LOADER time (see mintReceiptsForSettledAssessments,
 * called from src/loader/index.ts after payments/allocations load), using the
 * real payment/allocation data already in demo-data. By the time any resolve
 * call happens, every settled assessment with a real applied allocation
 * already has its receipt — resolve only ever reads (findReceiptForPayment).
 * No receipt number is invented: the algorithm is normative (§16.1), the
 * inputs (agency, value_date, sequence) are entirely real; only the *timing*
 * moved from request-time to load-time.
 */

const RECEIPT_SEQ_LOCK_KEY = 727_100_003;

export interface ReceiptInfo {
  receiptNo: string;
  businessDate: string;
  status: "VALID" | "VOIDED" | "REFUNDED";
}

/**
 * Pure read: the receipt for an assessment's earliest APPLIED payment
 * allocation, if one has already been minted. Never writes. Returns null if
 * the assessment has no applied allocation, or one exists but hasn't been
 * pre-minted (a data gap to report, not paper over by minting on the fly).
 */
export async function findReceiptForPayment(
  db: Kysely<Database>,
  assessmentId: string,
): Promise<ReceiptInfo | null> {
  const allocation = await db
    .selectFrom("payment_allocation")
    .select(["payment_id"])
    .where("assessment_id", "=", assessmentId)
    .where("status", "=", "APPLIED")
    .orderBy("applied_at", "asc")
    .limit(1)
    .executeTakeFirst();
  if (!allocation) return null;

  const receipt = await db
    .selectFrom("receipt")
    .select(["receipt_no", "business_date", "status"])
    .where("payment_id", "=", allocation.payment_id)
    .executeTakeFirst();
  if (!receipt) return null;

  return { receiptNo: receipt.receipt_no, businessDate: receipt.business_date, status: receipt.status };
}

/**
 * Loader-time backfill: mints a receipt for every SETTLED assessment that has
 * a real APPLIED payment_allocation and doesn't already have one, using the
 * exact same §16.1 gapless-per-agency-per-day algorithm. Idempotent — skips
 * any payment that already has a receipt (the `UNIQUE (payment_id)` on
 * `receipt` also enforces this at the DB level). Iterates in a fixed,
 * deterministic order (agency, then value_date, then payment_id) so repeated
 * loader runs against the same demo-data always produce the same sequence
 * numbers.
 */
export async function mintReceiptsForSettledAssessments(trx: Transaction<Database>, clock: Clock): Promise<number> {
  await sql`SELECT pg_advisory_xact_lock(${RECEIPT_SEQ_LOCK_KEY})`.execute(trx);

  const candidates = await trx
    .selectFrom("assessment")
    .innerJoin("payment_allocation", "payment_allocation.assessment_id", "assessment.id")
    .innerJoin("payment", "payment.id", "payment_allocation.payment_id")
    .innerJoin("agency", "agency.id", "payment.agency_id")
    .select(["payment.id as payment_id", "payment.agency_id", "payment.value_date", "agency.code as agency_code"])
    .where("assessment.status", "=", "SETTLED")
    .where("payment_allocation.status", "=", "APPLIED")
    .distinct()
    .orderBy("payment.agency_id", "asc")
    .orderBy("payment.value_date", "asc")
    .orderBy("payment.id", "asc")
    .execute();

  // Running per-(agency, business_date) counters, seeded from whatever's
  // already in the table (idempotent across repeated loader runs).
  const nextSeqByAgencyDate = new Map<string, number>();
  let minted = 0;

  for (const candidate of candidates) {
    if (!candidate.agency_id) continue; // the inner join to `agency` already guarantees this, but keep the type honest
    const existing = await trx
      .selectFrom("receipt")
      .select("receipt_no")
      .where("payment_id", "=", candidate.payment_id)
      .executeTakeFirst();
    if (existing) continue;

    const seqKey = `${candidate.agency_id}|${candidate.value_date}`;
    if (!nextSeqByAgencyDate.has(seqKey)) {
      const { count } = await trx
        .selectFrom("receipt")
        .select(({ fn }) => fn.countAll().as("count"))
        .where("agency_id", "=", candidate.agency_id)
        .where("business_date", "=", candidate.value_date)
        .executeTakeFirstOrThrow();
      nextSeqByAgencyDate.set(seqKey, Number(count) + 1);
    }
    const seq = nextSeqByAgencyDate.get(seqKey) as number;
    nextSeqByAgencyDate.set(seqKey, seq + 1);

    const dateCompact = candidate.value_date.replaceAll("-", "");
    const receiptNo = `${candidate.agency_code}${dateCompact}${String(seq).padStart(9, "0")}`;

    await trx
      .insertInto("receipt")
      .values({
        receipt_no: receiptNo,
        agency_id: candidate.agency_id,
        payment_id: candidate.payment_id,
        business_date: candidate.value_date,
        status: "VALID",
        issued_at: clock.now(),
      })
      .execute();
    minted++;
  }

  return minted;
}
