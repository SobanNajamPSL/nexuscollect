import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { capturePayment } from "../../src/modules/payment/index.js";
import { returnInstrument } from "../../src/modules/instrument/index.js";
import { loadSchemeCache } from "../../src/modules/resolution/scheme-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * §8.8/§14.6's cheque dishonour cascade, anchored to the real IN-0004 shape
 * (same 3 real assessments/amounts, same real dishonour charge) — the loaded
 * fixture's own IN-0004 row already sits in its POST-dishonour state
 * (status=RETURNED), so this proves the cascade mechanism itself using a
 * fresh synthetic instrument lodged against the same 3 real, still-open
 * assessments, settled for real via the apply pipeline, then returned.
 */
describe("Phase 3 (scoped): cheque dishonour cascade", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    await loadSchemeCache(testDb.db);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("returning the instrument reverses all 3 allocations, un-settles the 3 real assessments, voids the receipts, re-closes the service gate, and raises a dishonour charge", async () => {
    const psids = ["12010400001661551", "12010400001776532", "12010400001899869"];
    const amounts = [18_144_000n, 21_470_400n, 24_796_800n];

    const fbr = await testDb.db.selectFrom("agency").selectAll().where("code", "=", "FBR").executeTakeFirstOrThrow();
    const instrument = await testDb.db
      .insertInto("instrument")
      .values({ instrument_type: "CHEQUE", instrument_number: "TEST-004822", drawee_bank_bic: "UNILPKKA", drawer_name: "Ahmed Traders (Pvt) Ltd", amount_minor: 64_411_200n, agency_id: fbr.id, status: "LODGED", dishonour_charge_minor: 50_000n })
      .returning("id")
      .executeTakeFirstOrThrow();

    // One cheque = one payment (§6.8's own UNIQUE(instrument_id) constraint) —
    // split across all 3 real assessments via explicit allocations, exactly
    // matching IN-0004's own real linked_amounts structure.
    const result = await capturePayment(
      testDb.db,
      {
        paymentReference: "CHQTEST0001",
        channel: "OTC_CASH",
        rail: "CHEQUE_CLEARING",
        grossAmountMinor: 64_411_200n,
        valueDate: "2026-07-27",
        obligationDischargeDate: "2026-07-29",
        instrumentId: instrument.id,
        explicitAllocations: psids.map((psid, i) => ({ psid, amountMinor: amounts[i] as bigint })),
        captureOutcome: "CONFIRMED",
      },
      clock,
    );
    const paymentIds = [result.paymentId];
    expect(result.settledAssessmentIds).toHaveLength(3);

    // Confirm the pre-return state: all 3 settled, with real receipts.
    for (const psid of psids) {
      const a = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", psid).executeTakeFirstOrThrow();
      expect(a.status).toBe("SETTLED");
    }

    const cascade = await returnInstrument(testDb.db, instrument.id, "INSUFFICIENT_FUNDS", clock);

    expect(cascade.reversedPaymentIds.sort()).toEqual(paymentIds.sort());
    expect(cascade.unsettledAssessmentIds).toHaveLength(3);
    // One cheque = one payment = one receipt in this build's design (§16.1's
    // minimal Phase 1 slice mints one receipt per payment, not per assessment);
    // the spec's own "voids 3 receipts" framing for IN-0004 implies a receipt
    // per settled assessment even under one instrument — a real, disclosed
    // gap between that framing and this build's receipt model, not silently
    // reconciled. What IS proven here: the one real receipt this payment
    // minted gets voided, never deleted.
    expect(cascade.voidedReceiptIds).toHaveLength(1);
    expect(cascade.dishonourAssessmentId).not.toBeNull();

    for (const psid of psids) {
      const a = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", psid).executeTakeFirstOrThrow();
      expect(a.status).not.toBe("SETTLED"); // un-settled
      expect(a.allocated_amount_minor).toBe(0n); // allocation genuinely reversed
      expect(a.service_gate_released_at).toBeNull(); // gate re-closed
      // Surcharge resumes from the ORIGINAL due_date — no special-cased grace
      // period was introduced; compute_derived already accrues from due_date
      // unconditionally, so this holds without any dedicated cascade logic.
      expect(a.due_date).toBe("2026-07-25");
    }

    for (const paymentId of paymentIds) {
      const receipt = await testDb.db.selectFrom("receipt").selectAll().where("payment_id", "=", paymentId).executeTakeFirstOrThrow();
      expect(receipt.status).toBe("VOIDED"); // never deleted, just voided
    }

    const dishonourAssessment = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", cascade.dishonourAssessmentId as string).executeTakeFirstOrThrow();
    expect(dishonourAssessment.assessed_amount_minor).toBe(50_000n); // the real instrument's own dishonour_charge_minor
    expect(dishonourAssessment.status).toBe("ISSUED");

    const updatedInstrument = await testDb.db.selectFrom("instrument").selectAll().where("id", "=", instrument.id).executeTakeFirstOrThrow();
    expect(updatedInstrument.status).toBe("RETURNED");
    expect(updatedInstrument.return_reason_code).toBe("INSUFFICIENT_FUNDS");
    expect(updatedInstrument.dishonour_charge_assessment_id).toBe(cascade.dishonourAssessmentId);
  });

  it("calling returnInstrument twice on an already-returned instrument throws rather than double-cascading", async () => {
    const fbr = await testDb.db.selectFrom("agency").selectAll().where("code", "=", "FBR").executeTakeFirstOrThrow();
    const instrument = await testDb.db.insertInto("instrument").values({ instrument_type: "CHEQUE", amount_minor: 1000n, agency_id: fbr.id, status: "RETURNED" }).returning("id").executeTakeFirstOrThrow();
    await expect(returnInstrument(testDb.db, instrument.id, "INSUFFICIENT_FUNDS", clock)).rejects.toThrow(/already RETURNED/);
  });
});
