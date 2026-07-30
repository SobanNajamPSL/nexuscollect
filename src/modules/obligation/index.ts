import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import { syncResolutionIndex } from "./resolution-index-sync.js";
import type { Clock } from "../../platform/clock/index.js";

/**
 * §9.1's assessment state machine, the slice Phase 1 needs: create, amend
 * (new version, same PSID), cancel. "No status field may be assigned by
 * direct UPDATE" — every transition here goes through `applyTransition`,
 * which checks the move against an explicit table rather than trusting the
 * caller.
 */

type AssessmentStatus =
  | "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "SETTLED" | "OVERDUE" | "EXPIRED"
  | "CANCELLED" | "AMENDED" | "WRITTEN_OFF" | "CLOSED";

const ALLOWED_TRANSITIONS: Record<string, readonly AssessmentStatus[]> = {
  // §9.1: amendment is legal from any still-open state; the old version always becomes AMENDED.
  AMEND: ["DRAFT", "ISSUED", "PARTIALLY_PAID", "OVERDUE"],
  // §9.1: "Only from DRAFT, ISSUED, OVERDUE, EXPIRED with allocated = 0."
  CANCEL: ["DRAFT", "ISSUED", "OVERDUE", "EXPIRED"],
};

export class IllegalStateTransition extends Error {
  constructor(action: string, from: string) {
    super(`Illegal transition: cannot ${action} an assessment in status ${from}`);
    this.name = "IllegalStateTransition";
  }
}

export class CannotCancelPaidAssessment extends Error {
  constructor(assessmentId: string, allocatedMinor: bigint) {
    super(`Cannot cancel assessment ${assessmentId}: ${allocatedMinor} minor units already allocated — issue a refund instead`);
    this.name = "CannotCancelPaidAssessment";
  }
}

function assertTransitionAllowed(action: "AMEND" | "CANCEL", from: AssessmentStatus): void {
  if (!ALLOWED_TRANSITIONS[action]?.includes(from)) {
    throw new IllegalStateTransition(action, from);
  }
}

export interface CreateAssessmentInput {
  psid: string;
  agencyId: string;
  productId: string;
  payerId?: string;
  payerAccountId?: string;
  payerSnapshot: Record<string, unknown>;
  externalRef?: string;
  description: string;
  assessedAmountMinor: bigint;
  discountAppliedMinor?: bigint;
  issueDate: string;
  dueDate: string;
  expiryDate?: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export async function createAssessment(
  db: Kysely<Database>,
  input: CreateAssessmentInput,
  clock: Clock,
): Promise<{ id: string }> {
  return db.transaction().execute(async (trx) => {
    const discount = input.discountAppliedMinor ?? 0n;
    const payable = input.assessedAmountMinor - discount;
    const inserted = await trx
      .insertInto("assessment")
      .values({
        psid: input.psid,
        agency_id: input.agencyId,
        product_id: input.productId,
        payer_id: input.payerId ?? null,
        payer_account_id: input.payerAccountId ?? null,
        payer_snapshot: JSON.stringify(input.payerSnapshot) as never,
        external_ref: input.externalRef ?? null,
        description: input.description,
        assessed_amount_minor: input.assessedAmountMinor,
        discount_applied_minor: discount,
        payable_amount_minor: payable,
        allocated_amount_minor: 0n,
        balance_minor: payable,
        issue_date: input.issueDate,
        due_date: input.dueDate,
        expiry_date: input.expiryDate ?? null,
        status: "ISSUED",
        source: input.source,
        version: 1,
        metadata: JSON.stringify(input.metadata ?? {}) as never,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    await syncResolutionIndex(trx, inserted.id, true);
    return { id: inserted.id };
  });
}

export interface AmendAssessmentInput {
  assessedAmountMinor?: bigint;
  discountAppliedMinor?: bigint;
  description?: string;
  dueDate?: string;
  expiryDate?: string;
  metadata?: Record<string, unknown>;
}

export interface AmendAssessmentResult {
  newAssessmentId: string;
  version: number;
  /** Negative would mean the amendment reduced the payable below what's already
   * been allocated — §14.2 says this "triggers an automatic overpayment,"
   * which is a Phase 2 concern (moving money in payment_allocation). Phase 1
   * surfaces the figure rather than silently producing an invalid balance. */
  resultingBalanceMinor: bigint;
}

/** §9.1: "Never mutate a paid assessment's amounts in place. Create version
 * v+1, keep the same PSID, mark v as AMENDED, carry allocations forward." */
export async function amendAssessment(
  db: Kysely<Database>,
  assessmentId: string,
  changes: AmendAssessmentInput,
  clock: Clock,
): Promise<AmendAssessmentResult> {
  return db.transaction().execute(async (trx: Transaction<Database>) => {
    const old = await trx.selectFrom("assessment").selectAll().where("id", "=", assessmentId).executeTakeFirstOrThrow();
    assertTransitionAllowed("AMEND", old.status as AssessmentStatus);

    const assessedAmountMinor = changes.assessedAmountMinor ?? old.assessed_amount_minor;
    const discountAppliedMinor = changes.discountAppliedMinor ?? old.discount_applied_minor;
    const payableAmountMinor = assessedAmountMinor - discountAppliedMinor;
    // "carry allocations forward" — the new version starts already-allocated by
    // whatever was genuinely paid against the old version.
    const allocatedAmountMinor = old.allocated_amount_minor;
    const balanceMinor = payableAmountMinor - allocatedAmountMinor;

    const newId = randomUUID();
    await trx
      .insertInto("assessment")
      .values({
        id: newId,
        psid: old.psid, // same PSID — this is the point of amendment vs. a new obligation
        agency_id: old.agency_id,
        product_id: old.product_id,
        payer_id: old.payer_id,
        payer_account_id: old.payer_account_id,
        payer_snapshot: JSON.stringify(old.payer_snapshot) as never,
        external_ref: old.external_ref,
        description: changes.description ?? old.description,
        currency: old.currency,
        assessed_amount_minor: assessedAmountMinor,
        surcharge_accrued_minor: old.surcharge_accrued_minor,
        discount_applied_minor: discountAppliedMinor,
        payable_amount_minor: payableAmountMinor,
        allocated_amount_minor: allocatedAmountMinor,
        balance_minor: balanceMinor,
        issue_date: old.issue_date,
        due_date: changes.dueDate ?? old.due_date,
        expiry_date: changes.expiryDate ?? old.expiry_date,
        status: "ISSUED",
        source: old.source,
        version: old.version + 1,
        supersedes_id: old.id,
        metadata: JSON.stringify(changes.metadata ?? old.metadata) as never,
      })
      .execute();

    await trx.updateTable("assessment").set({ status: "AMENDED", updated_at: clock.now() }).where("id", "=", old.id).execute();

    await syncResolutionIndex(trx, old.id, false);
    await syncResolutionIndex(trx, newId, true);

    return { newAssessmentId: newId, version: old.version + 1, resultingBalanceMinor: balanceMinor };
  });
}

/** §9.1: "Only from DRAFT, ISSUED, OVERDUE, EXPIRED with allocated = 0. If any
 * money has been applied, the agency must issue a refund instead." */
export async function cancelAssessment(db: Kysely<Database>, assessmentId: string, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const assessment = await trx.selectFrom("assessment").selectAll().where("id", "=", assessmentId).executeTakeFirstOrThrow();
    assertTransitionAllowed("CANCEL", assessment.status as AssessmentStatus);
    if (assessment.allocated_amount_minor > 0n) {
      throw new CannotCancelPaidAssessment(assessmentId, assessment.allocated_amount_minor);
    }
    await trx.updateTable("assessment").set({ status: "CANCELLED", updated_at: clock.now() }).where("id", "=", assessmentId).execute();
    await syncResolutionIndex(trx, assessmentId, false);
  });
}
