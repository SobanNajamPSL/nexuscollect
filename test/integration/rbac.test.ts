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

const AGENCY_ADMIN_ID = "00000000-0000-4000-9000-000000000001"; // Bilal Farooq
const AGENCY_OPERATOR_ID = "00000000-0000-4000-9000-000000000002"; // Sana Malik — wrong role for approve

describe("Phase 11: RBAC (§3.2 roles, requireRole guard on product approval)", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  let productId: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    const clock = new DemoClock();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock, demoDataDir: DEMO_DATA_DIR });

    const agency = await testDb.db.selectFrom("agency").select("id").where("code", "=", "FBR").executeTakeFirstOrThrow();
    const scheme = await testDb.db.selectFrom("reference_scheme").select("id").where("agency_id", "=", agency.id).executeTakeFirstOrThrow();
    const head = await testDb.db.selectFrom("revenue_head").select("id").where("agency_id", "=", agency.id).executeTakeFirstOrThrow();
    const created = await app.inject({
      method: "POST",
      url: "/internal/agencies/FBR/products",
      payload: {
        code: "RBAC-TEST-PRODUCT", name: "RBAC Test Product", category: "FEE", reference_scheme_id: scheme.id,
        amount_rule: "ASSESSED", allow_partial: false, overpay_treatment: "REJECT", allocation_waterfall: "OLDEST_FIRST",
        allowed_channels: ["APP"], allowed_instruments: ["CASH"], instrument_credit_policy: "ON_CLEARING",
        fee_bearer: "PAYER", default_revenue_head_id: head.id, service_gating: "NONE", deposit_refundable: false,
        effective_from: "2026-07-30", actor_id: AGENCY_OPERATOR_ID,
      },
    });
    productId = created.json().productId as string;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  it("rejects with 401 when no x-user-id header is present", async () => {
    const response = await app.inject({
      method: "POST", url: `/internal/products/${productId}/approve`,
      payload: { checker_user_id: AGENCY_ADMIN_ID },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects with 403 when the caller holds the wrong role", async () => {
    const response = await app.inject({
      method: "POST", url: `/internal/products/${productId}/approve`,
      headers: { "x-user-id": AGENCY_OPERATOR_ID },
      payload: { checker_user_id: AGENCY_OPERATOR_ID },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN");
  });

  it("succeeds when the caller holds AGENCY_ADMIN", async () => {
    const response = await app.inject({
      method: "POST", url: `/internal/products/${productId}/approve`,
      headers: { "x-user-id": AGENCY_ADMIN_ID },
      payload: { checker_user_id: AGENCY_ADMIN_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ACTIVE");
  });

  it("GET /internal/roles returns all 12 seeded roles", async () => {
    const response = await app.inject({ method: "GET", url: "/internal/roles" });
    expect(response.statusCode).toBe(200);
    expect(response.json().length).toBe(12);
  });

  it("GET /internal/users returns the 10 seeded demo users with their role assignments", async () => {
    const response = await app.inject({ method: "GET", url: "/internal/users" });
    expect(response.statusCode).toBe(200);
    const users = response.json() as { id: string; name: string; roles: string[] }[];
    expect(users.length).toBe(10);
    const admin = users.find((u) => u.id === AGENCY_ADMIN_ID);
    expect(admin?.roles).toEqual(["AGENCY_ADMIN"]);
  });
});
