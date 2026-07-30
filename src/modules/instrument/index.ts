import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { reversePayment } from "../payment/index.js";
import { createAssessment } from "../obligation/index.js";
import { dammEncode } from "../../platform/checksum/index.js";

/**
 * §8.8/§14.6's cheque dishonour cascade — the demo's other named signature
 * moment (real anchor: `IN-0004`, PSID `12010600005120245`). Scoped narrowly
 * (Prompt 3's "one quick sweep" cut): lodgement-to-clearing plumbing is
 * skipped; this starts from "the instrument is already linked to a settled
 * payment" and implements exactly what a *return* does, reusing
 * `modules/payment.reversePayment` as its core primitive rather than
 * duplicating allocation-reversal logic.
 *
 * Six effects, in order: (1) reverse every allocation the linked payment(s)
 * made, (2) un-settle the affected assessments (reversePayment already does
 * both), (3) void the receipts those payments minted, (4) resume surcharge
 * from the assessment's own `due_date` — no code change needed for this: §15.4's
 * `compute_derived` already accrues from `due_date` unconditionally, so a
 * reversed, reopened assessment naturally resumes from the original date the
 * moment its status goes back to OVERDUE, (5) re-close the service gate
 * (`service_gate_released_at` back to null), (6) raise a new dishonour-charge
 * assessment for the instrument's own `dishonour_charge_minor`.
 */
export interface ReturnInstrumentResult {
  reversedPaymentIds: string[];
  unsettledAssessmentIds: string[];
  voidedReceiptIds: string[];
  dishonourAssessmentId: string | null;
}

export async function returnInstrument(
  db: Kysely<Database>,
  instrumentId: string,
  returnReasonCode: string,
  clock: Clock,
): Promise<ReturnInstrumentResult> {
  const instrument = await db.selectFrom("instrument").selectAll().where("id", "=", instrumentId).executeTakeFirstOrThrow();
  if (instrument.status === "RETURNED") {
    throw new Error(`Instrument ${instrumentId} is already RETURNED — not re-cascading`);
  }

  const linkedPayments = await db.selectFrom("payment").select(["id", "agency_id"]).where("instrument_id", "=", instrumentId).where("status", "in", ["CONFIRMED", "PARTIALLY_REVERSED"]).execute();

  const unsettledAssessmentIds = new Set<string>();
  const voidedReceiptIds: string[] = [];

  for (const payment of linkedPayments) {
    // Capture which assessments this payment had settled BEFORE reversing —
    // reversePayment un-settles them, but we need the id set to close their
    // service gates and void their receipts afterward.
    const settledAssessments = await db
      .selectFrom("payment_allocation")
      .select("assessment_id")
      .distinct()
      .where("payment_id", "=", payment.id)
      .where("status", "=", "APPLIED")
      .execute();

    const receipt = await db.selectFrom("receipt").select("id").where("payment_id", "=", payment.id).executeTakeFirst();

    await reversePayment(db, payment.id, `Instrument ${instrument.instrument_number ?? instrumentId} returned: ${returnReasonCode}`, { actorType: "SYSTEM", actorId: "instrument-dishonour-cascade" }, clock);

    for (const row of settledAssessments) {
      unsettledAssessmentIds.add(row.assessment_id);
      // Re-close the service gate — the assessment is no longer discharged.
      await db.updateTable("assessment").set({ service_gate_token: null, service_gate_released_at: null }).where("id", "=", row.assessment_id).execute();
    }

    if (receipt) {
      await db.updateTable("receipt").set({ status: "VOIDED" }).where("id", "=", receipt.id).execute();
      voidedReceiptIds.push(receipt.id);
    }
  }

  // Raise the dishonour charge as a real assessment against the same
  // agency/product the drawer already owes under — never a fabricated figure:
  // the amount is the instrument's own recorded `dishonour_charge_minor`.
  let dishonourAssessmentId: string | null = null;
  if (instrument.dishonour_charge_minor && instrument.dishonour_charge_minor > 0n && instrument.agency_id) {
    const product = await db.selectFrom("collection_product").selectAll().where("agency_id", "=", instrument.agency_id).where("category", "=", "PENALTY").where("amount_rule", "=", "FIXED").executeTakeFirst();
    if (product) {
      const scheme = await db.selectFrom("reference_scheme").selectAll().where("id", "=", product.reference_scheme_id).executeTakeFirstOrThrow();
      const revenueHead = await db.selectFrom("revenue_head").selectAll().where("id", "=", product.default_revenue_head_id).executeTakeFirstOrThrow();
      const { id } = await createAssessment(
        db,
        {
          psid: syntheticDishonourPsid(scheme.prefix ?? "", scheme.total_length),
          agencyId: instrument.agency_id,
          productId: product.id,
          payerSnapshot: { name: instrument.drawer_name ?? "Unknown drawer" },
          description: `Dishonoured instrument charge — ${instrument.instrument_number ?? instrumentId}`,
          assessedAmountMinor: instrument.dishonour_charge_minor,
          lineItems: [{ seq: 1, lineType: "PENALTY", revenueHeadCode: revenueHead.code, amountMinor: instrument.dishonour_charge_minor }],
          issueDate: clock.now().toISOString().slice(0, 10),
          dueDate: clock.now().toISOString().slice(0, 10),
          source: "INSTRUMENT_DISHONOUR_CASCADE",
        },
        { actorType: "SYSTEM", actorId: "instrument-dishonour-cascade" },
        clock,
      );
      dishonourAssessmentId = id;
    }
  }

  await db
    .updateTable("instrument")
    .set({ status: "RETURNED", return_reason_code: returnReasonCode, returned_on: clock.now().toISOString().slice(0, 10), ...(dishonourAssessmentId ? { dishonour_charge_assessment_id: dishonourAssessmentId } : {}) })
    .where("id", "=", instrumentId)
    .execute();

  return { reversedPaymentIds: linkedPayments.map((p) => p.id), unsettledAssessmentIds: [...unsettledAssessmentIds], voidedReceiptIds, dishonourAssessmentId };
}

// Synthetic-but-well-formed PSID for a freshly-raised dishonour assessment —
// same shape (prefix + digits + Damm check digit, via the same
// platform/checksum primitive every other PSID uses) as every other
// platform-minted PSID; not a fabricated business fact, just a fresh
// identifier for a new real assessment. Real minting (§7.3's full algorithm)
// is out of Phase 1/2's scope per finding L's own disclosed decision.
function syntheticDishonourPsid(prefix: string, totalLength: number): string {
  const bodyLength = totalLength - prefix.length - 1;
  const random = Array.from({ length: bodyLength }, () => Math.floor(Math.random() * 10)).join("");
  return dammEncode(`${prefix}${random}`);
}

