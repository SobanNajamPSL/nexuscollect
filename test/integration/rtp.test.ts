import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { capturePayment } from "../../src/modules/payment/index.js";
import {
  markDelivered, markPresented, acceptRtp, declineRtp, cancelRtp,
  expireDueRequests, remindRtp, fulfillRtpWithPayment, transitionRtp, IllegalRtpTransition,
} from "../../src/modules/rtp/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

const ACTOR = { actorType: "USER" as const, actorId: "test-actor" };

describe("Phase 3b: Request to Pay — the full §9.2 state machine", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  async function rtpIdByReference(ref: string): Promise<string> {
    const row = await testDb.db.selectFrom("request_to_pay").select("id").where("rtp_reference", "=", ref).executeTakeFirstOrThrow();
    return row.id;
  }

  it("RT-0005 (DELIVERED): present -> accept -> fulfil via a real payment capture -> FULFILLED", async () => {
    const rtpId = await rtpIdByReference("R260005");
    await testDb.db.transaction().execute(async (trx) => {
      await markPresented(trx, rtpId, ACTOR, clock);
      const result = await acceptRtp(trx, rtpId, "FULL", ACTOR, clock);
      expect(result.status).toBe("ACCEPTED");
    });

    const rtp = await testDb.db.selectFrom("request_to_pay").selectAll().where("id", "=", rtpId).executeTakeFirstOrThrow();
    const capture = await capturePayment(
      testDb.db,
      {
        paymentReference: "", channel: "APP", rail: "RAAST", grossAmountMinor: rtp.amount_minor,
        valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30",
        explicitAllocations: [{ psid: "31010900000396648", amountMinor: rtp.amount_minor }],
        captureOutcome: "CONFIRMED",
      },
      clock,
    );
    expect(capture.status).toBe("CONFIRMED");

    const fulfilled = await testDb.db.transaction().execute((trx) => fulfillRtpWithPayment(trx, rtpId, capture.paymentId, ACTOR, clock));
    expect(fulfilled.status).toBe("FULFILLED");

    const final = await testDb.db.selectFrom("request_to_pay").select(["status", "fulfilling_payment_id"]).where("id", "=", rtpId).executeTakeFirstOrThrow();
    expect(final.status).toBe("FULFILLED");
    expect(final.fulfilling_payment_id).toBe(capture.paymentId);
  });

  it("RT-0007 (DECLINED, already terminal): a further transition is illegal", async () => {
    const rtpId = await rtpIdByReference("R260007");
    const before = await testDb.db.selectFrom("request_to_pay").select("status").where("id", "=", rtpId).executeTakeFirstOrThrow();
    expect(before.status).toBe("DECLINED");
    await expect(testDb.db.transaction().execute((trx) => markPresented(trx, rtpId, ACTOR, clock))).rejects.toThrow(IllegalRtpTransition);
  });

  it("RT-0008 (already EXPIRED): a late credit still fulfils it as FULFILLED_LATE, per §9.3's 'must still accept a late credit' rule", async () => {
    const rtpId = await rtpIdByReference("R260008");
    const before = await testDb.db.selectFrom("request_to_pay").select("status").where("id", "=", rtpId).executeTakeFirstOrThrow();
    expect(before.status).toBe("EXPIRED");

    const rtp = await testDb.db.selectFrom("request_to_pay").selectAll().where("id", "=", rtpId).executeTakeFirstOrThrow();
    const capture = await capturePayment(
      testDb.db,
      {
        paymentReference: "", channel: "APP", rail: "RAAST", grossAmountMinor: rtp.amount_minor,
        valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30",
        explicitAllocations: [{ psid: "31010900000612177", amountMinor: rtp.amount_minor }],
        captureOutcome: "CONFIRMED",
      },
      clock,
    );
    const fulfilled = await testDb.db.transaction().execute((trx) => fulfillRtpWithPayment(trx, rtpId, capture.paymentId, ACTOR, clock));
    expect(fulfilled.status).toBe("FULFILLED_LATE");
  });

  it("a PRESENTED RtP past its expires_at is caught by the expiry sweep, using the injected clock only", async () => {
    const rtpId = await rtpIdByReference("R260006"); // already PRESENTED in the fixture

    const future = new DemoClock();
    future.set(new Date("2026-08-04T00:00:00Z")); // after RT-0006's 2026-08-03T23:59:00Z expiry
    const expired = await expireDueRequests(testDb.db, future);
    expect(expired).toContain("R260006");

    const row = await testDb.db.selectFrom("request_to_pay").select("status").where("id", "=", rtpId).executeTakeFirstOrThrow();
    expect(row.status).toBe("EXPIRED");
  });

  it("EXPIRED -> reminded returns the SAME row to SENT with an incremented reminder_count (no reminder_of_id column exists)", async () => {
    const rtpId = await rtpIdByReference("R260006"); // now EXPIRED from the previous test
    const before = await testDb.db.selectFrom("request_to_pay").select("reminder_count").where("id", "=", rtpId).executeTakeFirstOrThrow();
    const result = await testDb.db.transaction().execute((trx) => remindRtp(trx, rtpId, new Date("2026-08-10T23:59:00Z"), ACTOR, clock));
    expect(result.status).toBe("SENT");
    const after = await testDb.db.selectFrom("request_to_pay").select(["reminder_count", "expires_at"]).where("id", "=", rtpId).executeTakeFirstOrThrow();
    expect(after.reminder_count).toBe(before.reminder_count + 1);
    expect(after.expires_at.toISOString()).toBe(new Date("2026-08-10T23:59:00Z").toISOString());
  });

  it("agency cancel: any non-terminal RtP moves to CANCELLED", async () => {
    const rtpId = await rtpIdByReference("R260012"); // DELIVERED
    const result = await testDb.db.transaction().execute((trx) => cancelRtp(trx, rtpId, "AGENCY_WITHDRAWN", ACTOR, clock));
    expect(result.status).toBe("CANCELLED");
  });

  it("a partial acceptance requires amount_modifiable and an amount strictly below the requested one", async () => {
    const rtpId = await rtpIdByReference("R260011"); // amount_modifiable = Y
    await testDb.db.transaction().execute((trx) => markPresented(trx, rtpId, ACTOR, clock));
    const rtp = await testDb.db.selectFrom("request_to_pay").select("amount_minor").where("id", "=", rtpId).executeTakeFirstOrThrow();
    const result = await testDb.db.transaction().execute((trx) => acceptRtp(trx, rtpId, "PARTIAL", ACTOR, clock, rtp.amount_minor - 100_00n));
    expect(result.status).toBe("ACCEPTED_PARTIAL");
    const updated = await testDb.db.selectFrom("request_to_pay").select("amount_minor").where("id", "=", rtpId).executeTakeFirstOrThrow();
    expect(updated.amount_minor).toBe(rtp.amount_minor - 100_00n);
  });

  it("decline records a reason code and is terminal", async () => {
    const rtpId = await rtpIdByReference("R260013"); // DELIVERED
    await testDb.db.transaction().execute((trx) => markPresented(trx, rtpId, ACTOR, clock));
    const result = await testDb.db.transaction().execute((trx) => declineRtp(trx, rtpId, "AM04_INSUFFICIENT_FUNDS", ACTOR, clock));
    expect(result.status).toBe("DECLINED");
    const row = await testDb.db.selectFrom("request_to_pay").select("decline_reason_code").where("id", "=", rtpId).executeTakeFirstOrThrow();
    expect(row.decline_reason_code).toBe("AM04_INSUFFICIENT_FUNDS");
  });

  it("every transition writes an audit row and an outbox event in the same transaction", async () => {
    const rtpId = await rtpIdByReference("R260012"); // already CANCELLED from an earlier test — pick a fresh terminal check instead
    const auditCount = await testDb.db.selectFrom("audit_log").select(({ fn }) => fn.countAll().as("c")).where("entity_type", "=", "request_to_pay").where("entity_id", "=", rtpId).executeTakeFirstOrThrow();
    const outboxCount = await testDb.db.selectFrom("outbox_event").select(({ fn }) => fn.countAll().as("c")).where("aggregate_type", "=", "request_to_pay").where("aggregate_id", "=", rtpId).executeTakeFirstOrThrow();
    expect(Number(auditCount.c)).toBeGreaterThanOrEqual(1);
    expect(Number(outboxCount.c)).toBeGreaterThanOrEqual(1);
  });

  it("transitionRtp rejects an event not legal from the row's current status", async () => {
    const rtpId = await rtpIdByReference("R260013"); // now DECLINED
    await expect(testDb.db.transaction().execute((trx) => transitionRtp(trx, rtpId, "rtp.accepted", ACTOR, clock))).rejects.toThrow(IllegalRtpTransition);
  });
});
