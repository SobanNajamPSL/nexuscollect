import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import {
  withIdempotency,
  IdempotencyKeyReusedError,
  RequestInProgressError,
  purgeExpiredIdempotencyRecords,
  IDEMPOTENCY_RETENTION_DAYS,
} from "../../src/platform/idempotency/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";

/**
 * Finding H: §17.4 is exact — IN_PROGRESS means an immediate 409
 * REQUEST_IN_PROGRESS (Retry-After: 2), never a poll-and-wait. This rewrite
 * replaces the old test suite, which asserted the (incorrect) polling
 * behavior.
 */
describe("platform/idempotency (§17.4, exact semantics)", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("a later replay of the same key and body returns the original status/body without re-running the handler", async () => {
    const institutionId = randomUUID();
    let calls = 0;
    const params = {
      institutionId,
      endpoint: "/v1/payments",
      idempotencyKey: "key-1",
      requestBody: { amount: 100 },
    };
    const handler = async () => {
      calls++;
      return { status: 201, body: { paymentId: "P-1" } };
    };

    const first = await withIdempotency(testDb.db, params, handler, clock);
    expect(first.replayed).toBe(false);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ paymentId: "P-1" });

    const second = await withIdempotency(testDb.db, params, handler, clock);
    expect(second.replayed).toBe(true); // route layer sets X-Idempotent-Replay: true on this
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ paymentId: "P-1" });
    expect(calls).toBe(1); // handler ran exactly once
  });

  it("a different body with the same key gets 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const institutionId = randomUUID();
    const base = { institutionId, endpoint: "/v1/payments", idempotencyKey: "key-2" };
    await withIdempotency(
      testDb.db,
      { ...base, requestBody: { amount: 100 } },
      async () => ({ status: 201, body: { ok: true } }),
      clock,
    );

    const error = await withIdempotency(
      testDb.db,
      { ...base, requestBody: { amount: 999 } },
      async () => ({ status: 201, body: { ok: true } }),
      clock,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IdempotencyKeyReusedError);
    expect((error as IdempotencyKeyReusedError).httpStatus).toBe(422);
    expect((error as IdempotencyKeyReusedError).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  // Deterministic (no race-timing luck): manually plant an IN_PROGRESS row,
  // then confirm a caller who observes it gets an immediate 409 — never a wait.
  it("a request observing IN_PROGRESS gets an immediate 409 REQUEST_IN_PROGRESS with Retry-After: 2", async () => {
    const institutionId = randomUUID();
    const endpoint = "/v1/payments";
    const idempotencyKey = "key-in-progress";
    const requestBody = { amount: 42 };
    const fingerprint = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(JSON.stringify(requestBody)).digest(),
    );

    await testDb.db
      .insertInto("idempotency_record")
      .values({
        institution_id: institutionId,
        endpoint,
        idempotency_key: idempotencyKey,
        request_fingerprint: fingerprint,
        state: "IN_PROGRESS",
      })
      .execute();

    const start = performance.now();
    const error = await withIdempotency(
      testDb.db,
      { institutionId, endpoint, idempotencyKey, requestBody },
      async () => ({ status: 201, body: { shouldNeverRun: true } }),
      clock,
    ).catch((e: unknown) => e);
    const elapsedMs = performance.now() - start;

    expect(error).toBeInstanceOf(RequestInProgressError);
    expect((error as RequestInProgressError).httpStatus).toBe(409);
    expect((error as RequestInProgressError).retryAfterSeconds).toBe(2);
    expect(elapsedMs, "must reject immediately, not poll/wait").toBeLessThan(100);
  });

  it("50 concurrent identical requests: exactly one effect, exactly one record, every other caller either 409s or replays the same result", async () => {
    const institutionId = randomUUID();
    const params = {
      institutionId,
      endpoint: "/v1/payments",
      idempotencyKey: "key-concurrent",
      requestBody: { amount: 500 },
    };
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls++;
      await new Promise((resolve) => setTimeout(resolve, 100)); // slow enough that losers reliably observe IN_PROGRESS
      return { status: 201, body: { paymentId: "P-CONCURRENT" } };
    };

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () => withIdempotency(testDb.db, params, handler, clock)),
    );

    expect(handlerCalls).toBe(1); // the effect ran exactly once

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof withIdempotency<{ paymentId: string }>>>
    >[];
    const rejected = outcomes.filter((o) => o.status === "rejected");

    for (const f of fulfilled) {
      expect(f.value.status).toBe(201);
      expect(f.value.body).toEqual({ paymentId: "P-CONCURRENT" }); // never a different effect
    }
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(RequestInProgressError); // never any other error
    }
    expect(fulfilled.filter((f) => !f.value.replayed)).toHaveLength(1); // exactly one non-replay (the winner)
    expect(rejected.length, "with a 100ms handler and 50 truly concurrent callers, at least some should observe IN_PROGRESS").toBeGreaterThan(0);

    const rows = await testDb.db
      .selectFrom("idempotency_record")
      .selectAll()
      .where("institution_id", "=", institutionId)
      .where("idempotency_key", "=", "key-concurrent")
      .execute();
    expect(rows).toHaveLength(1); // exactly one record, regardless of how many callers raced
  });

  it("retains records per the configured retention period, then purges", async () => {
    expect(IDEMPOTENCY_RETENTION_DAYS).toBe(7); // §17.4 line 2397: "Records retained 7 days (configurable)"

    const institutionId = randomUUID();
    await withIdempotency(
      testDb.db,
      { institutionId, endpoint: "/v1/payments", idempotencyKey: "key-old", requestBody: { amount: 1 } },
      async () => ({ status: 201, body: {} }),
      clock,
    );

    const freshClock = new DemoClock();
    const purgedNone = await purgeExpiredIdempotencyRecords(testDb.db, freshClock);
    expect(purgedNone).toBe(0); // not yet 7 days old

    const eightDaysLater = new DemoClock();
    eightDaysLater.advance(8 * 24 * 60 * 60 * 1000);
    const purgedCount = await purgeExpiredIdempotencyRecords(testDb.db, eightDaysLater);
    expect(purgedCount).toBeGreaterThanOrEqual(1);

    const stillThere = await testDb.db
      .selectFrom("idempotency_record")
      .selectAll()
      .where("institution_id", "=", institutionId)
      .where("idempotency_key", "=", "key-old")
      .executeTakeFirst();
    expect(stillThere).toBeUndefined();
  });
});
