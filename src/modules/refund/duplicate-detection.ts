import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";

/**
 * §14.5's "probable duplicate" tier, split into its own file (no dependency
 * on `modules/payment`) so `modules/payment/index.ts` can import it
 * statically without creating a payment <-> refund import cycle (`refund`
 * itself needs `reversePayment` from `modules/payment`).
 */
export async function detectProbableDuplicate(
  db: Kysely<Database>,
  input: { assessmentId: string; grossAmountMinor: bigint; payerAccountMasked: string | null; nowIso: Date },
): Promise<{ paymentId: string } | null> {
  if (!input.payerAccountMasked) return null;
  const tenMinutesAgo = new Date(input.nowIso.getTime() - 10 * 60 * 1000);
  const candidate = await db
    .selectFrom("payment_allocation as pa")
    .innerJoin("payment as p", "p.id", "pa.payment_id")
    .select("p.id")
    .where("pa.assessment_id", "=", input.assessmentId)
    .where("p.gross_amount_minor", "=", input.grossAmountMinor)
    .where("p.payer_account_masked", "=", input.payerAccountMasked)
    .where("p.status", "=", "CONFIRMED")
    .where("p.confirmed_at", ">=", tenMinutesAgo)
    .executeTakeFirst();
  return candidate ? { paymentId: candidate.id } : null;
}
