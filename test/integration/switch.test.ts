import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { billInquiry, billPayment, billPaymentReversal, billPaymentAdvice } from "../../src/adapters/switch/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

// Real anchor: AS-00104, PSID 5101150000150, WASA water bill, PKR 2,330.00, ISSUED, due 2026-07-30.
const WASA_PSID = "5101150000150";
const WASA_AMOUNT_MINOR = 233_000n;

describe("Phase 3b: switch four-message biller contract (§8.6)", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("message 1: Bill Inquiry is a pure read — finds the real WASA bill, no state created", async () => {
    const auditBefore = await testDb.db.selectFrom("audit_log").select(({ fn }) => fn.countAll().as("c")).executeTakeFirstOrThrow();
    const res = await billInquiry(testDb.db, { acquirer_id: "NBPAACQ", stan: "000001", rrn: "26210000001", txn_date: "2026-07-30", consumer_number: WASA_PSID, biller_id: "NEXUSCOLLECT", channel: "ATM" }, clock);
    const auditAfter = await testDb.db.selectFrom("audit_log").select(({ fn }) => fn.countAll().as("c")).executeTakeFirstOrThrow();

    expect(res.response_code).toBe("00");
    expect(res.bill_status).toBe("UNPAID");
    expect(res.amount_within_due_date_minor).toBe(Number(WASA_AMOUNT_MINOR));
    expect(res.response_reference.length).toBeGreaterThan(0);
    expect(Number(auditAfter.c)).toBe(Number(auditBefore.c)); // genuinely no state written
  });

  it("message 1: an unknown consumer number returns response_code 14, not a 500", async () => {
    const res = await billInquiry(testDb.db, { acquirer_id: "NBPAACQ", stan: "000002", rrn: "26210000002", txn_date: "2026-07-30", consumer_number: "99999999999999999", biller_id: "NEXUSCOLLECT" }, clock);
    expect(res.response_code).toBe("14");
  });

  let wasaInquiryReference = "";

  it("message 2: Bill Payment settles the real bill using the echoed response_reference", async () => {
    const inquiry = await billInquiry(testDb.db, { acquirer_id: "MEZNACQ", stan: "100200", rrn: "26210100200", txn_date: "2026-07-30", consumer_number: WASA_PSID, biller_id: "NEXUSCOLLECT", channel: "ATM" }, clock);
    expect(inquiry.response_code).toBe("00");
    wasaInquiryReference = inquiry.response_reference;

    const payment = await billPayment(
      testDb.db,
      { acquirer_id: "MEZNACQ", stan: "100200", rrn: "26210100200", txn_date: "2026-07-30", consumer_number: WASA_PSID, biller_id: "NEXUSCOLLECT", response_reference: inquiry.response_reference, transaction_amount_minor: WASA_AMOUNT_MINOR },
      clock,
    );
    expect(payment.response_code).toBe("00");
    expect(payment.settled_amount_minor).toBe(Number(WASA_AMOUNT_MINOR));
    expect(payment.remaining_balance_minor).toBe(0);
    expect(payment.receipt_no.length).toBeGreaterThan(0);

    const assessment = await testDb.db.selectFrom("assessment").select("status").where("psid", "=", WASA_PSID).executeTakeFirstOrThrow();
    expect(assessment.status).toBe("SETTLED");
  });

  it("message 2 is idempotent on the switch's own keys — a replay returns the SAME original outcome, not a second payment", async () => {
    const before = await testDb.db.selectFrom("payment").select(({ fn }) => fn.countAll().as("c")).where("acquirer_id", "=", "MEZNACQ").where("switch_stan", "=", "100200").executeTakeFirstOrThrow();

    // A real switch retry resends the IDENTICAL original request, including
    // the same (still-valid) response_reference it was given the first time.
    const replay = await billPayment(
      testDb.db,
      { acquirer_id: "MEZNACQ", stan: "100200", rrn: "26210100200", txn_date: "2026-07-30", consumer_number: WASA_PSID, biller_id: "NEXUSCOLLECT", response_reference: wasaInquiryReference, transaction_amount_minor: WASA_AMOUNT_MINOR },
      clock,
    );
    expect(replay.response_code).toBe("00");
    expect(replay.settled_amount_minor).toBe(Number(WASA_AMOUNT_MINOR));

    const after = await testDb.db.selectFrom("payment").select(({ fn }) => fn.countAll().as("c")).where("acquirer_id", "=", "MEZNACQ").where("switch_stan", "=", "100200").executeTakeFirstOrThrow();
    expect(Number(after.c)).toBe(Number(before.c)); // exactly one payment, regardless of the replay
  });

  it("message 3: a reversal WITHOUT its original is stored PENDING_ORIGINAL, not rejected or lost", async () => {
    const res = await billPaymentReversal(testDb.db, { acquirer_id: "NBPAACQ", original_stan: "900001", original_rrn: "26219000001", txn_date: "2026-07-30", reversal_reason: "TIMEOUT" }, clock);
    expect(res.reversal_state).toBe("PENDING_ORIGINAL");
    expect(res.original_payment_reference).toBeNull();

    const row = await testDb.db.selectFrom("switch_pending_reversal").selectAll().where("acquirer_id", "=", "NBPAACQ").where("original_stan", "=", "900001").executeTakeFirstOrThrow();
    expect(row.status).toBe("PENDING_ORIGINAL");
  });

  it("the late original auto-pairs with its pending reversal and reverses the payment it just settled", async () => {
    // A fresh WASA-shaped bill for a clean payment to reverse: reuse a second real
    // ISSUED assessment so this test doesn't depend on the earlier SETTLED one.
    const psid = "5101150000188";
    const inquiry = await billInquiry(testDb.db, { acquirer_id: "NBPAACQ", stan: "900001", rrn: "26219000001", txn_date: "2026-07-30", consumer_number: psid, biller_id: "NEXUSCOLLECT" }, clock);
    expect(inquiry.response_code).toBe("00");
    const amount = BigInt(inquiry.amount_within_due_date_minor ?? 0);

    const payment = await billPayment(
      testDb.db,
      { acquirer_id: "NBPAACQ", stan: "900001", rrn: "26219000001", txn_date: "2026-07-30", consumer_number: psid, biller_id: "NEXUSCOLLECT", response_reference: inquiry.response_reference, transaction_amount_minor: amount },
      clock,
    );
    expect(payment.response_code).toBe("00");

    const row = await testDb.db.selectFrom("payment").select("status").where("payment_reference", "=", payment.payment_reference).executeTakeFirstOrThrow();
    expect(row.status).toBe("REVERSED"); // auto-paired with the PENDING_ORIGINAL reversal from the previous test, on arrival

    const pending = await testDb.db.selectFrom("switch_pending_reversal").select("status").where("acquirer_id", "=", "NBPAACQ").where("original_stan", "=", "900001").executeTakeFirstOrThrow();
    expect(pending.status).toBe("PAIRED_AND_REVERSED");
  });

  it("message 4: advice resolves an UNCERTAIN payment to CONFIRMED", async () => {
    const psid = "5101150000214";
    await testDb.db
      .insertInto("payment")
      .values({
        payment_reference: "PMTESTADVICE1", channel: "BILLER", rail: "IBFT_1LINK", gross_amount_minor: 100_00n, net_to_agency_minor: 100_00n,
        status: "UNCERTAIN", value_date: "2026-07-30", obligation_discharge_date: "2026-07-30",
        acquirer_id: "SCBLACQ", switch_stan: "700001", switch_rrn: "26217000001",
      })
      .execute();
    void psid;

    const advice = await billPaymentAdvice(testDb.db, { acquirer_id: "SCBLACQ", original_stan: "700001", original_rrn: "26217000001", txn_date: "2026-07-30", advice_outcome: "CONFIRMED" }, clock);
    expect(advice.response_code).toBe("00");
    expect(advice.resolved_status).toBe("CONFIRMED");
  });
});
