import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { sql } from "kysely";
import { DemoClock } from "../../src/platform/clock/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");
const INSTITUTION = "00000000-0000-4000-8000-0000000000d1";
const DATE = "2026-07-30";

/**
 * A Request to Pay is fulfilled by the money arriving, not by an operator
 * remembering to record it (§9.2).
 *
 * Accepting a request and paying it are two different events: acceptance is the
 * payer agreeing, and the money still arrives through their own bank on the
 * ordinary channel pipeline. Fulfilment links the two — and before this, nothing
 * did it automatically. The lifecycle stalled at ACCEPTED unless somebody called
 * the fulfil endpoint by hand, which no screen offers, so an agency could see which
 * of its requests had been accepted and never which had been paid.
 */
describe("Request to Pay fulfilment (§9.2)", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock, demoDataDir: DEMO_DATA_DIR });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  /**
   * A seeded request that is out for delivery and whose bill is still unpaid.
   *
   * The "still unpaid" part matters: three of the four seeded DELIVERED requests
   * are against bills that were already paid, and one of those would resolve to
   * nothing and fail for a reason unrelated to what is being tested.
   */
  async function deliveredRequest(): Promise<{ id: string; reference: string; psid: string }> {
    const rows = await testDb.db
      .selectFrom("request_to_pay")
      .innerJoin("assessment", (join) => join.onRef("assessment.id", "=", sql`request_to_pay.assessment_ids[1]`))
      .select(["request_to_pay.id", "request_to_pay.rtp_reference", "assessment.psid"])
      .where("request_to_pay.status", "=", "DELIVERED")
      .where("assessment.balance_minor", ">", 0n)
      .orderBy("request_to_pay.rtp_reference", "asc")
      .execute();

    const next = rows[0];
    if (!next) throw new Error("no unpaid DELIVERED request in the seed set");
    return { id: next.id, reference: next.rtp_reference, psid: next.psid };
  }

  async function act(rtpId: string, action: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: `/internal/rtp/${rtpId}/transition`, headers: { "x-institution-id": INSTITUTION }, payload: { action } });
    expect(res.statusCode, `${action}: ${res.body}`).toBe(200);
    return (res.json() as { status: string }).status;
  }

  /** Pay a bill the ordinary way, exactly as the citizen portal does. */
  async function payByLookup(psid: string, key: string): Promise<string> {
    const resolved = await app.inject({ method: "POST", url: "/v1/resolve", headers: { "x-institution-id": INSTITUTION }, payload: { key_type: "PSID", key_value: psid, channel: "APP" } });
    const { resolution_token } = resolved.json() as { resolution_token: string };

    const intent = await app.inject({ method: "POST", url: "/v1/payment-intents", headers: { "x-institution-id": INSTITUTION, "idempotency-key": `i-${key}` }, payload: { resolution_token, channel: "APP" } });
    const { intent_reference, total_debit_minor } = intent.json() as { intent_reference: string; total_debit_minor: number };

    const payment = await app.inject({
      method: "POST",
      url: "/v1/payments",
      headers: { "x-institution-id": INSTITUTION, "idempotency-key": `p-${key}` },
      payload: { intent_reference, channel: "APP", rail: "RAAST", gross_amount_minor: total_debit_minor, value_date: DATE, obligation_discharge_date: DATE, capture_outcome: "CONFIRMED" },
    });
    expect(payment.statusCode, payment.body).toBe(201);
    return (payment.json() as { payment_reference: string }).payment_reference;
  }

  async function statusOf(rtpId: string): Promise<{ status: string; fulfilling_payment_id: string | null }> {
    return testDb.db.selectFrom("request_to_pay").select(["status", "fulfilling_payment_id"]).where("id", "=", rtpId).executeTakeFirstOrThrow();
  }

  it("walks the full lifecycle and closes itself when the payer actually pays", async () => {
    const rtp = await deliveredRequest();
    expect(await act(rtp.id, "present")).toBe("PRESENTED");
    expect(await act(rtp.id, "accept")).toBe("ACCEPTED");

    // Accepting is agreeing, not paying. Nothing has been collected yet.
    expect((await statusOf(rtp.id)).status).toBe("ACCEPTED");

    const reference = await payByLookup(rtp.psid, "fulfil");

    const after = await statusOf(rtp.id);
    expect(after.status).toBe("FULFILLED");
    expect(after.fulfilling_payment_id).not.toBeNull();

    // And it points at the payment that actually settled it.
    const payment = await testDb.db.selectFrom("payment").select("payment_reference").where("id", "=", after.fulfilling_payment_id!).executeTakeFirstOrThrow();
    expect(payment.payment_reference).toBe(reference);
  });

  it("leaves a request that was never accepted alone, even when its bill is paid", async () => {
    // Paying a bill does not retroactively mean the payer agreed to a request they
    // never responded to — the request's own outcome is a separate fact.
    // Raises its own request rather than taking one from the seed set: only one
    // seeded DELIVERED request still has an unpaid bill, and the test above needs it.
    const bill = await testDb.db
      .selectFrom("assessment")
      .select("psid")
      .where("status", "=", "OVERDUE")
      .where("balance_minor", ">", 0n)
      .orderBy("psid", "desc")
      .executeTakeFirstOrThrow();

    const created = await app.inject({
      method: "POST",
      url: "/internal/rtp",
      headers: { "x-institution-id": INSTITUTION, "idempotency-key": "rtp-unaccepted" },
      payload: { psid: bill.psid, payer_alias_type: "MSISDN", payer_alias_value: "+923001012633" },
    });
    const { rtp_id } = created.json() as { rtp_id: string };
    for (const action of ["send", "deliver"]) await act(rtp_id, action);

    await payByLookup(bill.psid, "unaccepted");
    expect((await statusOf(rtp_id)).status).toBe("DELIVERED");
  });

  it("does not close a multi-bill request when only one of its bills is settled", async () => {
    const [first, second] = await testDb.db
      .selectFrom("assessment")
      .select(["id", "psid", "agency_id", "balance_minor"])
      .where("status", "=", "OVERDUE")
      .where("balance_minor", ">", 0n)
      .orderBy("psid", "asc")
      .limit(2)
      .execute();

    const created = await app.inject({
      method: "POST",
      url: "/internal/rtp",
      headers: { "x-institution-id": INSTITUTION, "idempotency-key": "rtp-multi" },
      payload: { psid: first!.psid, payer_alias_type: "MSISDN", payer_alias_value: "+923001012633" },
    });
    const { rtp_id } = created.json() as { rtp_id: string };

    // Widen it to cover a second bill, then take it to ACCEPTED.
    await testDb.db.updateTable("request_to_pay").set({ assessment_ids: [first!.id, second!.id] }).where("id", "=", rtp_id).execute();
    for (const action of ["send", "deliver", "present", "accept"]) await act(rtp_id, action);

    await payByLookup(first!.psid, "multi-partial");
    expect((await statusOf(rtp_id)).status, "one of two bills paid must not fulfil it").toBe("ACCEPTED");

    // Settling the last outstanding bill closes it, even though a *different*
    // payment settled the first one.
    await payByLookup(second!.psid, "multi-rest");
    expect((await statusOf(rtp_id)).status).toBe("FULFILLED");
  });

  it("records a payment against an expired request as fulfilled late, not as fulfilled", async () => {
    const rtp = await testDb.db
      .selectFrom("request_to_pay")
      .select(["id", "assessment_ids"])
      .where("status", "=", "EXPIRED")
      .executeTakeFirst();
    if (!rtp) return; // no expired request in the seed set

    const assessment = await testDb.db
      .selectFrom("assessment")
      .select(["psid", "balance_minor"])
      .where("id", "=", (rtp.assessment_ids as string[])[0]!)
      .executeTakeFirstOrThrow();
    if (assessment.balance_minor <= 0n) return; // already settled in the seed data

    await payByLookup(assessment.psid, "late");
    expect((await statusOf(rtp.id)).status).toBe("FULFILLED_LATE");
  });
});
