import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { signReceiptPayload, type SignedReceipt } from "../../platform/receipt-signing/index.js";

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
 * Mints the next gapless receipt number for one payment, §16.1's algorithm
 * exactly: `{AGENCY}{YYYYMMDD}{9-digit seq}`, seq allocated from a real COUNT
 * against `receipt` under an advisory lock (never an in-memory counter) so
 * concurrent mints for the same agency/day never collide or gap. Used by
 * Phase 2's live apply pipeline (`modules/payment`) for a newly-settled
 * payment, and by the loader-time batch backfill below for historical ones —
 * same function, same algorithm, two call sites.
 */
export async function mintReceiptForPayment(
  trx: Transaction<Database>,
  params: { paymentId: string; agencyId: string; agencyCode: string; businessDate: string },
  clock: Clock,
): Promise<{ receiptNo: string }> {
  await sql`SELECT pg_advisory_xact_lock(${RECEIPT_SEQ_LOCK_KEY})`.execute(trx);

  const existing = await trx.selectFrom("receipt").select("receipt_no").where("payment_id", "=", params.paymentId).executeTakeFirst();
  if (existing) return { receiptNo: existing.receipt_no };

  const { count } = await trx
    .selectFrom("receipt")
    .select(({ fn }) => fn.countAll().as("count"))
    .where("agency_id", "=", params.agencyId)
    .where("business_date", "=", params.businessDate)
    .executeTakeFirstOrThrow();
  const seq = Number(count) + 1;
  const dateCompact = params.businessDate.replaceAll("-", "");
  const receiptNo = `${params.agencyCode}${dateCompact}${String(seq).padStart(9, "0")}`;

  await trx
    .insertInto("receipt")
    .values({ receipt_no: receiptNo, agency_id: params.agencyId, payment_id: params.paymentId, business_date: params.businessDate, status: "VALID", issued_at: clock.now() })
    .execute();

  return { receiptNo };
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

export interface SignedReceiptBundle extends SignedReceipt {
  receiptNo: string;
}

/**
 * §16.1's "detached digital signature over a canonical JSON of the receipt
 * fields" + §16.2's offline-verifiable QR payload. Assembles the real
 * receipt/payment/allocation/agency data already on file — nothing invented
 * — canonicalises it, and signs it with the fixed demo Ed25519 key
 * (`platform/receipt-signing`). A holder of just `{canonicalPayload,
 * signatureBase64, publicKeyPem}` can verify authenticity with zero network
 * access, which is the whole point of §16.2's "scan, disconnect, verify" demo.
 */
export async function getSignedReceiptBundle(db: Kysely<Database>, receiptNo: string): Promise<SignedReceiptBundle | null> {
  const receipt = await db
    .selectFrom("receipt")
    .innerJoin("payment", "payment.id", "receipt.payment_id")
    .innerJoin("agency", "agency.id", "receipt.agency_id")
    .select(["receipt.receipt_no", "receipt.business_date", "receipt.status", "receipt.issued_at", "payment.payment_reference", "payment.gross_amount_minor", "payment.channel", "payment.rail", "payment.value_date", "payment.obligation_discharge_date", "agency.name as agency_name", "agency.code as agency_code"])
    .where("receipt.receipt_no", "=", receiptNo)
    .executeTakeFirst();
  if (!receipt) return null;

  const allocations = await db
    .selectFrom("payment_allocation")
    .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
    .innerJoin("revenue_head", "revenue_head.id", "payment_allocation.revenue_head_id")
    .select(["assessment.psid", "assessment.payer_snapshot", "revenue_head.code as head_code", "revenue_head.name as head_name", "payment_allocation.amount_minor"])
    .where("payment_allocation.payment_id", "=", (qb) => qb.selectFrom("receipt").select("payment_id").where("receipt_no", "=", receiptNo).limit(1))
    .where("payment_allocation.status", "=", "APPLIED")
    .execute();

  const payload = {
    receipt_no: receipt.receipt_no,
    payment_reference: receipt.payment_reference,
    agency_name: receipt.agency_name,
    agency_code: receipt.agency_code,
    business_date: receipt.business_date,
    status: receipt.status,
    channel: receipt.channel,
    rail: receipt.rail,
    value_date: receipt.value_date,
    obligation_discharge_date: receipt.obligation_discharge_date,
    gross_amount_minor: receipt.gross_amount_minor.toString(),
    issued_at: receipt.issued_at.toISOString(),
    head_wise: allocations.map((a) => ({ psid: a.psid, payer_name: (a.payer_snapshot as { name?: string } | null)?.name ?? null, head_code: a.head_code, head_name: a.head_name, amount_minor: a.amount_minor.toString() })),
  };

  const signed = signReceiptPayload(payload);
  return { receiptNo: receipt.receipt_no, ...signed };
}
