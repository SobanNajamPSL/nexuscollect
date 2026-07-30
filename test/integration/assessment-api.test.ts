import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * Finding L: the four assessment CRUD routes, end to end against real
 * Postgres — OpenAPI-conformant bodies, Idempotency-Key required, audit +
 * outbox via the domain layer, transition guards, the paid-cancellation
 * guard, Problem-shaped errors.
 */
describe("Phase 1 finding L: assessment CRUD API", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  const headers = { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": "test-key-create-001" };

  it("POST /v1/agency/assessments creates a real assessment with real line items", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agency/assessments",
      headers,
      payload: {
        product_code: "FBR-IT-COMP",
        psid: "12019900011111101",
        description: "API test assessment",
        assessed_amount_minor: 500000,
        issue_date: "2026-07-01",
        due_date: "2026-08-01",
        line_items: [{ seq: 1, line_type: "PRINCIPAL", revenue_head_code: "B01101", amount_minor: 500000 }],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.psid).toBe("12019900011111101");
    expect(body.status).toBe("ISSUED");
    expect(body.version).toBe(1);
    expect(body.assessed_amount_minor).toBe(500000);
    expect(body.line_items).toHaveLength(1);
  });

  it("replaying the same Idempotency-Key returns the stored result verbatim with X-Idempotent-Replay", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/agency/assessments",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": "test-key-replay-001" },
      payload: {
        product_code: "FBR-IT-COMP",
        psid: "12019900022222201",
        assessed_amount_minor: 100000,
        issue_date: "2026-07-01",
        due_date: "2026-08-01",
        line_items: [{ seq: 1, line_type: "PRINCIPAL", revenue_head_code: "B01101", amount_minor: 100000 }],
      },
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/agency/assessments",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": "test-key-replay-001" },
      payload: {
        product_code: "FBR-IT-COMP",
        psid: "12019900022222201",
        assessed_amount_minor: 100000,
        issue_date: "2026-07-01",
        due_date: "2026-08-01",
        line_items: [{ seq: 1, line_type: "PRINCIPAL", revenue_head_code: "B01101", amount_minor: 100000 }],
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.json()).toEqual(first.json());

    const rows = await testDb.db.selectFrom("assessment").select("id").where("psid", "=", "12019900022222201").execute();
    expect(rows).toHaveLength(1); // handler ran exactly once
  });

  it("reusing an Idempotency-Key with a different body is rejected with 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const key = "test-key-reused-001";
    await app.inject({
      method: "POST",
      url: "/v1/agency/assessments",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": key },
      payload: {
        product_code: "FBR-IT-COMP",
        psid: "12019900033333301",
        assessed_amount_minor: 100000,
        issue_date: "2026-07-01",
        due_date: "2026-08-01",
        line_items: [{ seq: 1, line_type: "PRINCIPAL", revenue_head_code: "B01101", amount_minor: 100000 }],
      },
    });

    const conflicting = await app.inject({
      method: "POST",
      url: "/v1/agency/assessments",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": key },
      payload: {
        product_code: "FBR-IT-COMP",
        psid: "12019900033333302", // different body under the same key
        assessed_amount_minor: 200000,
        issue_date: "2026-07-01",
        due_date: "2026-08-01",
        line_items: [{ seq: 1, line_type: "PRINCIPAL", revenue_head_code: "B01101", amount_minor: 200000 }],
      },
    });
    expect(conflicting.statusCode).toBe(422);
    expect(conflicting.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("GET /v1/agency/assessments/:psid returns the current version; 404 for an unknown PSID", async () => {
    const found = await app.inject({ method: "GET", url: "/v1/agency/assessments/12019900011111101", headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001" } });
    expect(found.statusCode).toBe(200);
    expect(found.json().psid).toBe("12019900011111101");

    const missing = await app.inject({ method: "GET", url: "/v1/agency/assessments/99999999999999999", headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001" } });
    expect(missing.statusCode).toBe(404);
  });

  it("PATCH amends the assessment: new version, same PSID, overpayment fields present", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/agency/assessments/12019900011111101",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": "test-key-amend-001" },
      payload: { expected_version: 1, reason_code: "CLERICAL_ERROR", description: "Corrected description" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.version).toBe(2);
    expect(body.psid).toBe("12019900011111101");
    expect(body.description).toBe("Corrected description");
    expect(body.overpayment_recognised_minor).toBe(0);
    expect(body.refund_id).toBeNull();
  });

  it("PATCH with a stale expected_version returns 409 VERSION_CONFLICT", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/agency/assessments/12019900011111101",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": "test-key-amend-stale-001" },
      payload: { expected_version: 1, reason_code: "CLERICAL_ERROR" }, // already at version 2
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("VERSION_CONFLICT");
  });

  it("POST cancel on an unpaid assessment succeeds; on a paid one returns 409 CANNOT_CANCEL_PAID_ASSESSMENT", async () => {
    const unpaid = await app.inject({
      method: "POST",
      url: "/v1/agency/assessments/12019900011111101/cancel",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": "test-key-cancel-001" },
      payload: { reason_code: "DUPLICATE" },
    });
    expect(unpaid.statusCode).toBe(200);
    expect(unpaid.json().status).toBe("CANCELLED");

    const paid = await app.inject({
      method: "POST",
      url: "/v1/agency/assessments/12010100000485997/cancel", // AS-00004, PARTIALLY_PAID
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001", "idempotency-key": "test-key-cancel-paid-001" },
      payload: { reason_code: "DUPLICATE" },
    });
    expect(paid.statusCode).toBe(409);
    expect(paid.json().code).toBe("CANNOT_CANCEL_PAID_ASSESSMENT");
  });

  it("state-changing routes require an Idempotency-Key header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agency/assessments",
      headers: { "x-institution-id": "00000000-0000-4000-8000-000000000001" }, // no idempotency-key
      payload: {
        product_code: "FBR-IT-COMP",
        psid: "12019900099999901",
        assessed_amount_minor: 100000,
        issue_date: "2026-07-01",
        due_date: "2026-08-01",
        line_items: [{ seq: 1, line_type: "PRINCIPAL", revenue_head_code: "B01101", amount_minor: 100000 }],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
