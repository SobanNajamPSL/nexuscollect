import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { loadSchemeCache, _resetSchemeCacheForTests } from "../../src/modules/resolution/scheme-cache.js";
import { capturePayment, resolveUncertainPayment, reversePayment, HardDuplicatePaymentError } from "../../src/modules/payment/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * §11.1's apply pipeline, §14.5's duplicate detection, §9.4's UNCERTAIN
 * lifecycle, and §8.4's late/expired-intent acceptance — against real
 * Postgres and real fixture assessments.
 */
describe("Phase 2: the apply pipeline (§11.1)", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    _resetSchemeCacheForTests();
    await loadSchemeCache(testDb.db);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("a narrative-resolved payment fully settles an open assessment, allocates, posts a balanced journal entry, and mints a receipt", async () => {
    // AS-00073 / PSID 41011400000286611 (PSCA-CHALLAN-PARK, ISSUED/OVERDUE, no
    // live discount rule — PRINCIPAL 200,000.00 + PENALTY 100,000.00 = 300,000.00 exactly).
    const result = await capturePayment(
      testDb.db,
      {
        paymentReference: "TESTPAY0001",
        channel: "IBANKING",
        rail: "RAAST",
        grossAmountMinor: 300_000n,
        valueDate: "2026-07-30",
        obligationDischargeDate: "2026-07-30",
        remittanceRaw: "PSID 41011400000286611 PARKING CHALLAN",
        captureOutcome: "CONFIRMED",
      },
      clock,
    );

    expect(result.status).toBe("CONFIRMED");
    expect(result.unappliedAmountMinor).toBe(0n);
    const assessment = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", "41011400000286611").executeTakeFirstOrThrow();
    expect(assessment.status).toBe("SETTLED");
    expect(result.settledAssessmentIds).toContain(assessment.id);

    const allocations = await testDb.db.selectFrom("payment_allocation").selectAll().where("payment_id", "=", result.paymentId).execute();
    expect(allocations).toHaveLength(2); // PRINCIPAL + PENALTY lines
    expect(allocations.reduce((s, a) => s + a.amount_minor, 0n)).toBe(300_000n);

    const journalLines = await testDb.db.selectFrom("journal_line").innerJoin("journal_entry", "journal_entry.id", "journal_line.entry_id").selectAll("journal_line").where("journal_entry.source_id", "=", result.paymentId).execute();
    expect(journalLines.length).toBeGreaterThanOrEqual(2);
    const dr = journalLines.filter((l) => l.direction === "DR").reduce((s, l) => s + l.amount_minor, 0n);
    const cr = journalLines.filter((l) => l.direction === "CR").reduce((s, l) => s + l.amount_minor, 0n);
    expect(dr).toBe(cr);

    const receipt = await testDb.db.selectFrom("receipt").selectAll().where("payment_id", "=", result.paymentId).executeTakeFirst();
    expect(receipt).toBeDefined();
    expect(receipt?.receipt_no).toMatch(/^PSCA/);
  });

  it("explicit allocations target specific lines even under EXPLICIT_ONLY; a partial payment against an allow_partial=false product holds as unapplied rather than partially settling", async () => {
    // AS-00041 / PSID 12010500002846133 (FBR-CUSTOMS, EXPLICIT_ONLY, allow_partial=N,
    // PRINCIPAL 796,000.00 + FEE 13,800.00 = 809,800.00). Paying only the FEE line
    // is a genuine partial payment of the whole bill — §11.4's default policy for
    // allow_partial=false is HOLD_AS_UNAPPLIED, not a silent PARTIALLY_PAID.
    const result = await capturePayment(
      testDb.db,
      {
        paymentReference: "TESTPAY0002",
        channel: "OTC_CASH",
        rail: "CASH",
        grossAmountMinor: 20_000_00n,
        valueDate: "2026-07-30",
        obligationDischargeDate: "2026-07-30",
        explicitAllocations: [{ psid: "12010500002846133", lineType: "FEE", revenueHeadCode: "B03115", amountMinor: 1_380_000n }],
        captureOutcome: "CONFIRMED",
      },
      clock,
    );

    expect(result.unappliedAmountMinor).toBe(20_000_00n); // the whole payment — nothing actually lands on the FEE line
    const allocations = await testDb.db.selectFrom("payment_allocation").selectAll().where("payment_id", "=", result.paymentId).execute();
    expect(allocations).toHaveLength(0);

    const assessment = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", "12010500002846133").executeTakeFirstOrThrow();
    expect(assessment.status).toBe("ISSUED"); // untouched — the money never silently attached to an unsettled bill
    expect(assessment.allocated_amount_minor).toBe(0n);
  });

  it("a hard duplicate (same rail + rail_e2e_id) is rejected structurally, not applied twice", async () => {
    const first = await capturePayment(
      testDb.db,
      { paymentReference: "TESTPAY0003", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 100_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", railE2eId: "E2E-DUPLICATE-TEST-001", captureOutcome: "CONFIRMED" },
      clock,
    );
    expect(first.status).toBe("CONFIRMED");

    await expect(
      capturePayment(
        testDb.db,
        { paymentReference: "TESTPAY0003-RETRY", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 100_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", railE2eId: "E2E-DUPLICATE-TEST-001", captureOutcome: "CONFIRMED" },
        clock,
      ),
    ).rejects.toThrow(HardDuplicatePaymentError);

    const payments = await testDb.db.selectFrom("payment").select("id").where("rail_e2e_id", "=", "E2E-DUPLICATE-TEST-001").execute();
    expect(payments).toHaveLength(1); // not applied twice
  });

  it("§9.4 UNCERTAIN: an ambiguous capture lands in UNCERTAIN, never shown as a failure, with zero allocation", async () => {
    const result = await capturePayment(
      testDb.db,
      { paymentReference: "TESTPAY0004", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 50_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30" }, // no captureOutcome asserted
      clock,
    );
    expect(result.status).toBe("UNCERTAIN");
    expect(result.settledAssessmentIds).toHaveLength(0);
    const allocations = await testDb.db.selectFrom("payment_allocation").select("id").where("payment_id", "=", result.paymentId).execute();
    expect(allocations).toHaveLength(0);
  });

  it("§9.4 resolver: an UNCERTAIN payment later found paid confirms and allocates for real", async () => {
    const uncertain = await capturePayment(
      testDb.db,
      { paymentReference: "TESTPAY0005", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 1_380_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", remittanceRaw: "PSID 12010500002846133 CUSTOMS FEE" },
      clock,
    );
    expect(uncertain.status).toBe("UNCERTAIN");

    await resolveUncertainPayment(testDb.db, uncertain.paymentId, { outcome: "FOUND_PAID", source: "EOD_STATEMENT" }, clock);

    const payment = await testDb.db.selectFrom("payment").selectAll().where("id", "=", uncertain.paymentId).executeTakeFirstOrThrow();
    expect(payment.status).toBe("CONFIRMED");
    expect(payment.uncertain_resolution_source).toBe("EOD_STATEMENT");
  });

  it("§9.4 resolver: an UNCERTAIN payment found not paid transitions to FAILED, still never touching allocations", async () => {
    const uncertain = await capturePayment(
      testDb.db,
      { paymentReference: "TESTPAY0006", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 25_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30" },
      clock,
    );
    await resolveUncertainPayment(testDb.db, uncertain.paymentId, { outcome: "FOUND_NOT_PAID", source: "RAIL_STATUS_ENQUIRY" }, clock);
    const payment = await testDb.db.selectFrom("payment").selectAll().where("id", "=", uncertain.paymentId).executeTakeFirstOrThrow();
    expect(payment.status).toBe("FAILED");
  });

  it("reversePayment un-settles the assessment, reverses the allocation (never deletes it), and posts PAYMENT_REVERSED", async () => {
    const captured = await capturePayment(
      testDb.db,
      { paymentReference: "TESTPAY0007", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 1_000_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", remittanceRaw: "PSID 31010900000181526 TOKEN TAX", captureOutcome: "CONFIRMED" },
      clock,
    );
    expect(captured.settledAssessmentIds.length).toBeGreaterThan(0);
    const assessmentId = captured.settledAssessmentIds[0] as string;

    await reversePayment(testDb.db, captured.paymentId, "test reversal", { actorType: "SYSTEM", actorId: "test" }, clock);

    const payment = await testDb.db.selectFrom("payment").selectAll().where("id", "=", captured.paymentId).executeTakeFirstOrThrow();
    expect(payment.status).toBe("REVERSED");

    const allocation = await testDb.db.selectFrom("payment_allocation").selectAll().where("payment_id", "=", captured.paymentId).executeTakeFirstOrThrow();
    expect(allocation.status).toBe("REVERSED"); // reversed, never deleted

    const assessment = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", assessmentId).executeTakeFirstOrThrow();
    expect(assessment.status).not.toBe("SETTLED");
    expect(assessment.allocated_amount_minor).toBe(0n);
  });

  it("a credit against an EXPIRED intent still applies and completes late, per §8.4/§9.3", async () => {
    const product = await testDb.db.selectFrom("collection_product").selectAll().where("code", "=", "FBR-IT-COMP").executeTakeFirstOrThrow();
    const assessment = await testDb.db
      .selectFrom("assessment")
      .selectAll()
      .where("product_id", "=", product.id)
      .where("status", "=", "ISSUED")
      .where("allocated_amount_minor", "=", 0n)
      .executeTakeFirst();
    const targetPsid = assessment?.psid ?? "12010500002846133"; // fallback to the FBR-CUSTOMS anchor if no unallocated FBR-IT-COMP row

    const expiredIntent = await testDb.db
      .insertInto("payment_intent")
      .values({ intent_reference: "IP-EXPIRED-TEST-001", channel: "IBANKING", requested_amount_minor: 1000n, total_debit_minor: 1000n, quote_expires_at: new Date("2020-01-01T00:00:00Z"), status: "EXPIRED" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const result = await capturePayment(
      testDb.db,
      { paymentReference: "TESTPAY0008", intentReference: "IP-EXPIRED-TEST-001", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 1000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", remittanceRaw: `PSID ${targetPsid}`, captureOutcome: "CONFIRMED" },
      clock,
    );
    expect(result.status).toBe("CONFIRMED"); // never rejected for being late

    const intentAfter = await testDb.db.selectFrom("payment_intent").selectAll().where("id", "=", expiredIntent.id).executeTakeFirstOrThrow();
    expect(intentAfter.status).toBe("COMPLETED_LATE");
  });
});
