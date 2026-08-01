import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { reversePayment } from "../payment/index.js";

/**
 * §14.4: recall and cancellation requests (`camt.056` in, `camt.029` out).
 * "Do not automatically return the funds" — every recall is recorded and
 * decided per the payment's actual state, never a blind reversal.
 */
export type RecallOutcome = "RETURNED" | "AGENCY_DECISION_PENDING" | "REJECTED";

export interface RecallResult {
  recallId: string;
  outcome: RecallOutcome;
  camt029Reason: string;
}

export async function receiveRecall(db: Kysely<Database>, paymentId: string, requestedReason: string, clock: Clock): Promise<RecallResult> {
  const payment = await db.selectFrom("payment").selectAll().where("id", "=", paymentId).executeTakeFirstOrThrow();
  const allocations = await db.selectFrom("payment_allocation").select(["status", "swept_in_payment_id"]).where("payment_id", "=", paymentId).execute();

  const anyAllocated = allocations.some((a) => a.status === "APPLIED");
  const anySwept = allocations.some((a) => a.status === "APPLIED" && a.swept_in_payment_id !== null);

  let outcome: RecallOutcome;
  let camt029Reason: string;

  if (anySwept) {
    // §14.4 step 5: money has already left for the government — the
    // platform cannot return it; the requester is pointed to the agency's
    // refund process instead.
    outcome = "REJECTED";
    camt029Reason = "AC04: funds transferred to beneficiary";
  } else if (anyAllocated) {
    // §14.4 step 4: allocated but not yet swept — this IS government revenue
    // now; the platform cannot unilaterally decide, the agency must.
    outcome = "AGENCY_DECISION_PENDING";
    camt029Reason = "PDNG: agency decision required (allocated, unswept)";
  } else {
    // §14.4 step 3: unallocated and unswept — return it.
    await reversePayment(db, paymentId, `Recall: ${requestedReason}`, { actorType: "INSTITUTION", actorId: "recall-requester" }, clock);
    outcome = "RETURNED";
    camt029Reason = "ACCC: accepted, funds returned";
  }

  const inserted = await db
    .insertInto("recall_request")
    .values({
      payment_id: paymentId, requested_reason: requestedReason,
      status: outcome === "RETURNED" ? "RETURNED" : outcome === "AGENCY_DECISION_PENDING" ? "AGENCY_DECISION_PENDING" : "REJECTED",
      camt029_reason: camt029Reason, resolved_at: outcome === "RETURNED" ? clock.now() : null,
      created_at: clock.now(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { recallId: inserted.id, outcome, camt029Reason };
}
