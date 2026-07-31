import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { markSent, markDelivered, markPresented, acceptRtp, fulfillRtpWithPayment } from "../rtp/index.js";
import { capturePayment } from "../payment/index.js";

/**
 * §8.11: "A mandate is best implemented as an automated RtP with
 * pre-granted consent... reuse the RtP machinery" — this module IS that
 * reuse: `collectUnderMandate` drives a real `request_to_pay` row through
 * the same state machine a manual RtP goes through, just without waiting
 * for the payer (consent was already granted when the mandate was set up).
 * No second, parallel collection engine.
 */

const MAX_RETRIES = 2;
const RETRY_INTERVAL_DAYS = 3;

function generateMandateReference(): string {
  return `MD${randomBytes(6).toString("hex").toUpperCase()}`;
}

export interface CreateMandateInput {
  payerId: string;
  productId: string;
  maxAmountMinor: bigint;
  frequency: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  firstCollectionDate: string;
  finalCollectionDate?: string;
}

export async function createMandate(db: Kysely<Database>, input: CreateMandateInput): Promise<{ mandateId: string; mandateReference: string }> {
  const mandateReference = generateMandateReference();
  const inserted = await db
    .insertInto("mandate")
    .values({
      mandate_reference: mandateReference, payer_id: input.payerId, product_id: input.productId, max_amount_minor: input.maxAmountMinor,
      frequency: input.frequency, first_collection_date: input.firstCollectionDate, final_collection_date: input.finalCollectionDate ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { mandateId: inserted.id, mandateReference };
}

export interface MandateCollectionResult {
  outcome: "COLLECTED" | "FAILED_RETRY_SCHEDULED" | "SUSPENDED";
  paymentId?: string;
  retryCount: number;
}

/**
 * §8.11 step 4: pre-notification is the CALLER's job (a real notification
 * dispatch — Phase 6 territory); this function is the collection itself,
 * assumed to run only after that notice has gone out.
 */
export async function collectUnderMandate(
  db: Kysely<Database>,
  mandateId: string,
  rtpAssessmentIds: readonly string[],
  psid: string,
  amountMinor: bigint,
  valueDate: string,
  clock: Clock,
): Promise<MandateCollectionResult> {
  const mandate = await db.selectFrom("mandate").selectAll().where("id", "=", mandateId).executeTakeFirstOrThrow();
  if (mandate.status !== "ACTIVE") throw new Error(`Mandate ${mandateId} is not ACTIVE (currently ${mandate.status})`);
  if (amountMinor > mandate.max_amount_minor) throw new Error(`Collection amount ${amountMinor} exceeds mandate max ${mandate.max_amount_minor}`);

  const rtp = await db
    .insertInto("request_to_pay")
    .values({
      rtp_reference: `MDRT${randomBytes(4).toString("hex").toUpperCase()}`,
      agency_id: (await db.selectFrom("collection_product").select("agency_id").where("id", "=", mandate.product_id).executeTakeFirstOrThrow()).agency_id,
      assessment_ids: rtpAssessmentIds as string[],
      payer_id: mandate.payer_id,
      payer_alias_type: "FREE_TEXT",
      amount_minor: amountMinor,
      amount_modifiable: false,
      expires_at: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000),
      status: "CREATED",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const actor = { actorType: "SYSTEM" as const, actorId: "mandate-engine" };
  await db.transaction().execute(async (trx) => {
    await markSent(trx, rtp.id, `MANDATE-${mandate.mandate_reference}`, actor, clock);
    await markDelivered(trx, rtp.id, actor, clock);
    await markPresented(trx, rtp.id, actor, clock);
    // Pre-granted consent — auto-accept on the payer's behalf, no waiting.
    await acceptRtp(trx, rtp.id, "FULL", actor, clock);
  });

  const capture = await capturePayment(
    db,
    {
      paymentReference: "", channel: "APP", rail: "RAAST", grossAmountMinor: amountMinor, valueDate, obligationDischargeDate: valueDate,
      explicitAllocations: [{ psid, amountMinor }], captureOutcome: "CONFIRMED",
    },
    clock,
  );

  if (capture.status === "CONFIRMED" && capture.settledAssessmentIds.length > 0) {
    await db.transaction().execute((trx) => fulfillRtpWithPayment(trx, rtp.id, capture.paymentId, actor, clock));
    await db.updateTable("mandate").set({ retry_count: 0 }).where("id", "=", mandateId).execute();
    return { outcome: "COLLECTED", paymentId: capture.paymentId, retryCount: 0 };
  }

  // §8.11 step 6: retry policy {max: 2, interval_days: 3}, then SUSPENDED.
  const newRetryCount = mandate.retry_count + 1;
  if (newRetryCount > MAX_RETRIES) {
    await db.updateTable("mandate").set({ status: "SUSPENDED" }).where("id", "=", mandateId).execute();
    return { outcome: "SUSPENDED", retryCount: newRetryCount };
  }
  await db.updateTable("mandate").set({ retry_count: newRetryCount }).where("id", "=", mandateId).execute();
  void RETRY_INTERVAL_DAYS; // documents the scheme rule; actual scheduling is the caller's job (no job runner in this demo)
  return { outcome: "FAILED_RETRY_SCHEDULED", retryCount: newRetryCount };
}

export async function cancelMandate(db: Kysely<Database>, mandateId: string): Promise<void> {
  await db.updateTable("mandate").set({ status: "CANCELLED" }).where("id", "=", mandateId).execute();
}
