import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { withIdempotency, IdempotencyConflictError } from "../../src/platform/idempotency/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";

describe("platform/idempotency (§17.4)", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("replaying the same key and body returns the original status/body without re-running the handler", async () => {
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
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ paymentId: "P-1" });
    expect(calls).toBe(1); // handler ran exactly once
  });

  // PROMPTS.md Prompt 0, acceptance test 5, second clause: "different body = 422."
  it("rejects the same key reused with a different body", async () => {
    const institutionId = randomUUID();
    const base = { institutionId, endpoint: "/v1/payments", idempotencyKey: "key-2" };
    await withIdempotency(
      testDb.db,
      { ...base, requestBody: { amount: 100 } },
      async () => ({ status: 201, body: { ok: true } }),
      clock,
    );

    await expect(
      withIdempotency(
        testDb.db,
        { ...base, requestBody: { amount: 999 } },
        async () => ({ status: 201, body: { ok: true } }),
        clock,
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  // PROMPTS.md Prompt 0, acceptance test 5, third clause: "50 concurrent
  // identical requests create exactly one record."
  it("50 concurrent identical requests create exactly one record and run the handler once", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 20)); // simulate real work
      return { status: 201, body: { paymentId: "P-CONCURRENT" } };
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => withIdempotency(testDb.db, params, handler, clock)),
    );

    expect(handlerCalls).toBe(1);
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ paymentId: "P-CONCURRENT" });
    }
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);

    const rows = await testDb.db
      .selectFrom("idempotency_record")
      .selectAll()
      .where("institution_id", "=", institutionId)
      .where("idempotency_key", "=", "key-concurrent")
      .execute();
    expect(rows).toHaveLength(1); // exactly one record
  });
});
