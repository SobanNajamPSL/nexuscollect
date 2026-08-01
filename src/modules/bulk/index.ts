import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { dammValidate } from "../../platform/checksum/index.js";
import { capturePayment } from "../payment/index.js";

/**
 * §8.10's bulk corporate file payment. "Validate the whole file before
 * accepting any of it" — every row is checked against the real DB before the
 * batch can move to VALIDATED, and the default policy on any invalid row is
 * `REJECT_ALL` (the safest of the three §8.10 lists), matching the demo
 * anchor: `bulk_payment_input.csv`'s row 13 references an already-settled
 * PSID, and the whole 12-row-otherwise-valid file must be rejected for it.
 */

export interface BulkFileRow {
  rowNo: number;
  psid: string;
  amountMinor: bigint;
}

export interface BulkRowValidation {
  rowNo: number;
  psid: string;
  amountMinor: bigint;
  outcome: "VALID" | "INVALID";
  errorCode?: string;
}

export interface ValidateBulkFileResult {
  batchId: string;
  bulkReference: string;
  status: "VALIDATED" | "REJECTED";
  rejectionReason: string | null;
  rows: BulkRowValidation[];
}

function generateBulkReference(): string {
  return `BLK${randomBytes(6).toString("hex").toUpperCase()}`;
}

async function validateRow(db: Kysely<Database>, row: BulkFileRow): Promise<BulkRowValidation> {
  if (!dammValidate(row.psid)) {
    return { ...row, outcome: "INVALID", errorCode: "INVALID_REFERENCE_CHECKSUM" };
  }
  const assessment = await db.selectFrom("assessment").select(["id", "status", "balance_minor"]).where("psid", "=", row.psid).executeTakeFirst();
  if (!assessment) return { ...row, outcome: "INVALID", errorCode: "PSID_NOT_FOUND" };
  if (assessment.status === "SETTLED") return { ...row, outcome: "INVALID", errorCode: "ALREADY_SETTLED" };
  if (!["ISSUED", "PARTIALLY_PAID", "OVERDUE"].includes(assessment.status)) return { ...row, outcome: "INVALID", errorCode: "ASSESSMENT_NOT_PAYABLE" };
  if (row.amountMinor <= 0n) return { ...row, outcome: "INVALID", errorCode: "INVALID_AMOUNT" };
  return { ...row, outcome: "VALID" };
}

/**
 * File-level control record: row count and total must match what the
 * uploader declared, and the same file content (by hash) can never be
 * ingested twice — both checked before any row-level validation runs.
 */
export async function validateBulkFile(
  db: Kysely<Database>,
  input: { rows: readonly BulkFileRow[]; declaredRowCount: number; declaredTotalMinor: bigint; fileContent: string; submittedByInstitutionId?: string },
  clock: Clock,
): Promise<ValidateBulkFileResult> {
  const fileHash = createHash("sha256").update(input.fileContent).digest("hex");
  const existing = await db.selectFrom("bulk_batch").select(["id", "bulk_reference", "status", "rejection_reason"]).where("file_hash", "=", fileHash).executeTakeFirst();
  if (existing) {
    const rows = await db.selectFrom("bulk_batch_row").selectAll().where("batch_id", "=", existing.id).orderBy("row_no").execute();
    return {
      batchId: existing.id, bulkReference: existing.bulk_reference, status: existing.status === "REJECTED" ? "REJECTED" : "VALIDATED",
      rejectionReason: existing.rejection_reason,
      rows: rows.map((r) => ({ rowNo: r.row_no, psid: r.psid, amountMinor: r.amount_minor, outcome: r.outcome, ...(r.error_code ? { errorCode: r.error_code } : {}) })),
    };
  }

  const actualTotal = input.rows.reduce((s, r) => s + r.amountMinor, 0n);
  const controlOk = input.rows.length === input.declaredRowCount && actualTotal === input.declaredTotalMinor;

  const validations = await Promise.all(input.rows.map((r) => validateRow(db, r)));
  const anyInvalid = validations.some((v) => v.outcome === "INVALID");
  const status: "VALIDATED" | "REJECTED" = !controlOk || anyInvalid ? "REJECTED" : "VALIDATED";
  const rejectionReason = !controlOk
    ? `Control total/row-count mismatch: declared ${input.declaredRowCount} rows / ${input.declaredTotalMinor}, parsed ${input.rows.length} rows / ${actualTotal}`
    : anyInvalid
      ? `${validations.filter((v) => v.outcome === "INVALID").length} row(s) failed validation — REJECT_ALL (default policy)`
      : null;

  const bulkReference = generateBulkReference();
  const inserted = await db
    .insertInto("bulk_batch")
    .values({
      bulk_reference: bulkReference, file_hash: fileHash, submitted_by_institution_id: input.submittedByInstitutionId ?? null,
      declared_row_count: input.declaredRowCount, declared_total_minor: input.declaredTotalMinor, status,
      rejection_reason: rejectionReason,
      created_at: clock.now(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  if (validations.length > 0) {
    await db
      .insertInto("bulk_batch_row")
      .values(validations.map((v) => ({ batch_id: inserted.id, row_no: v.rowNo, psid: v.psid, amount_minor: v.amountMinor, outcome: v.outcome, error_code: v.errorCode ?? null })))
      .execute();
  }
  void clock;

  return { batchId: inserted.id, bulkReference, status, rejectionReason, rows: validations };
}

export class BulkBatchNotValidatedError extends Error {
  readonly httpStatus = 409;
  readonly code = "BULK_BATCH_NOT_VALIDATED";
  constructor(batchId: string, status: string) {
    super(`Bulk batch ${batchId} is ${status}, not VALIDATED — cannot confirm`);
    this.name = "BulkBatchNotValidatedError";
  }
}

/**
 * §8.10 steps 4-6: one credit for the whole file, allocated to every row's
 * assessment in a single `payment` — reuses `capturePayment`'s existing
 * `explicitAllocations` mechanism (already proven by the cheque cascade and
 * switch adapter) rather than a parallel allocation engine.
 */
export async function confirmBulkBatch(db: Kysely<Database>, batchId: string, valueDate: string, clock: Clock): Promise<{ paymentId: string; settledCount: number }> {
  const batch = await db.selectFrom("bulk_batch").selectAll().where("id", "=", batchId).executeTakeFirstOrThrow();
  if (batch.status !== "VALIDATED") throw new BulkBatchNotValidatedError(batchId, batch.status);

  const rows = await db.selectFrom("bulk_batch_row").selectAll().where("batch_id", "=", batchId).orderBy("row_no").execute();
  const capture = await capturePayment(
    db,
    {
      paymentReference: "", channel: "APP", rail: "IBFT_1LINK", grossAmountMinor: batch.declared_total_minor,
      valueDate, obligationDischargeDate: valueDate,
      explicitAllocations: rows.map((r) => ({ psid: r.psid, amountMinor: r.amount_minor })),
      captureOutcome: "CONFIRMED",
    },
    clock,
  );

  await db.updateTable("bulk_batch").set({ status: "APPLIED", payment_id: capture.paymentId }).where("id", "=", batchId).execute();
  await db.updateTable("payment").set({ bulk_batch_id: batchId }).where("id", "=", capture.paymentId).execute();

  return { paymentId: capture.paymentId, settledCount: capture.settledAssessmentIds.length };
}
