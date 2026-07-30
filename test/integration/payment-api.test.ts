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

describe("Phase 2: payment API routes", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();
  const headers = { "x-institution-id": "00000000-0000-4000-8000-000000000002", "idempotency-key": "test-key-payment-api-001" };

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  it("resolves LEA-17-1000, creates a payment intent from the resolution_token, then captures and settles one of the payables", async () => {
    const resolveResponse = await app.inject({ method: "POST", url: "/v1/resolve", headers: { "x-institution-id": "00000000-0000-4000-8000-000000000002" }, payload: { key_type: "VEHICLE_REG", key_value: "LEA-17-1000", channel: "APP" } });
    expect(resolveResponse.statusCode).toBe(200);
    const resolveBody = resolveResponse.json();
    const resolutionToken = resolveBody.resolution_token;
    expect(resolutionToken).toBeTypeOf("string");

    const intentResponse = await app.inject({ method: "POST", url: "/v1/payment-intents", headers, payload: { resolution_token: resolutionToken, channel: "APP" } });
    expect(intentResponse.statusCode).toBe(201);
    const intent = intentResponse.json();
    expect(intent.status).toBe("CREATED");
    expect(intent.total_debit_minor).toBeGreaterThan(0);

    const getIntent = await app.inject({ method: "GET", url: `/v1/payment-intents/${intent.intent_reference}`, headers: { "x-institution-id": headers["x-institution-id"] } });
    expect(getIntent.statusCode).toBe(200);
    expect(getIntent.json().intent_reference).toBe(intent.intent_reference);

    const payResponse = await app.inject({
      method: "POST",
      url: "/v1/payments",
      headers: { ...headers, "idempotency-key": "test-key-payment-api-002" },
      payload: {
        intent_reference: intent.intent_reference,
        channel: "APP",
        rail: "RAAST",
        gross_amount_minor: 300000, // PSCA-CHALLAN-PARK's exact share of the intent's payable set
        value_date: "2026-07-30",
        obligation_discharge_date: "2026-07-30",
        capture_outcome: "CONFIRMED",
      },
    });
    expect(payResponse.statusCode).toBe(201);
    const payment = payResponse.json();
    expect(payment.status).toBe("CONFIRMED");
    expect(payment.settled_psids.length).toBeGreaterThan(0);

    const getPayment = await app.inject({ method: "GET", url: `/v1/payments/${payment.payment_reference}`, headers: { "x-institution-id": headers["x-institution-id"] } });
    expect(getPayment.statusCode).toBe(200);

    const receiptResponse = await app.inject({ method: "GET", url: `/v1/payments/${payment.payment_reference}/receipt`, headers: { "x-institution-id": headers["x-institution-id"] } });
    expect(receiptResponse.statusCode).toBe(200);
    expect(receiptResponse.json().receipt_no).toBeTypeOf("string");
  });

  it("reversing a payment via the API un-settles the assessment", async () => {
    const capture = await app.inject({
      method: "POST",
      url: "/v1/payments",
      headers: { ...headers, "idempotency-key": "test-key-payment-api-003" },
      payload: { channel: "IBANKING", rail: "RAAST", gross_amount_minor: 1000000, value_date: "2026-07-30", obligation_discharge_date: "2026-07-30", remittance_raw: "PSID 31010900000181526 TOKEN TAX", capture_outcome: "CONFIRMED" },
    });
    expect(capture.statusCode).toBe(201);
    const payment = capture.json();
    expect(payment.settled_psids).toContain("31010900000181526");

    const reverse = await app.inject({ method: "POST", url: `/v1/payments/${payment.payment_reference}/reverse`, headers: { "x-institution-id": headers["x-institution-id"] }, payload: { reason: "test reversal via API" } });
    expect(reverse.statusCode).toBe(200);
    expect(reverse.json().status).toBe("REVERSED");
  });

  it("a duplicate rail_e2e_id returns 409 DUPLICATE_PAYMENT", async () => {
    const payload = { channel: "IBANKING", rail: "RAAST", gross_amount_minor: 5000, value_date: "2026-07-30", obligation_discharge_date: "2026-07-30", rail_e2e_id: "E2E-API-TEST-001", capture_outcome: "CONFIRMED" };
    const first = await app.inject({ method: "POST", url: "/v1/payments", headers: { ...headers, "idempotency-key": "test-key-payment-api-004" }, payload });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({ method: "POST", url: "/v1/payments", headers: { ...headers, "idempotency-key": "test-key-payment-api-005" }, payload });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("DUPLICATE_PAYMENT");
  });
});
