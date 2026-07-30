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
 * Finding I (audit): resolve must compute agency/product/channel eligibility
 * and expiry live, on every read — never silently folding any of these into
 * an empty 200. Uses real fixture PSIDs throughout; agency/product `status`
 * is flipped directly in the already-loaded test database for the ineligible
 * cases (never a demo-data edit), matching this test suite's existing
 * pattern for synthetic test-only state (see resolve-key-types.test.ts).
 */
describe("Phase 1 finding I: eligibility and expiry", () => {
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

  it("channel not in the product's allowed_channels returns 403 CHANNEL_NOT_ELIGIBLE, not an empty 200", async () => {
    // AS-00057 / PSID 31010900000181526, product ETPB-TOKEN-CAR, whose
    // allowed_channels never lists POS.
    const response = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": "bank-test-001" },
      payload: { key_type: "PSID", key_value: "31010900000181526", channel: "POS" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("CHANNEL_NOT_ELIGIBLE");
  });

  it("agency.status != ACTIVE returns 503 AGENCY_UNAVAILABLE when it's the only candidate, not an empty 200", async () => {
    const etpb = await testDb.db.selectFrom("agency").selectAll().where("code", "=", "ETPB").executeTakeFirstOrThrow();
    await testDb.db.updateTable("agency").set({ status: "SUSPENDED" }).where("id", "=", etpb.id).execute();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/resolve",
        headers: { "x-institution-id": "bank-test-001" },
        payload: { key_type: "PSID", key_value: "31010900000181526", channel: "APP" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("AGENCY_UNAVAILABLE");
    } finally {
      await testDb.db.updateTable("agency").set({ status: "ACTIVE" }).where("id", "=", etpb.id).execute();
    }
  });

  it("a multi-agency lookup with one agency suspended still returns the eligible agency's payables (partial exclusion, not a blanket error)", async () => {
    const etpb = await testDb.db.selectFrom("agency").selectAll().where("code", "=", "ETPB").executeTakeFirstOrThrow();
    await testDb.db.updateTable("agency").set({ status: "SUSPENDED" }).where("id", "=", etpb.id).execute();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/resolve",
        headers: { "x-institution-id": "bank-test-001" },
        payload: { key_type: "VEHICLE_REG", key_value: "LEA-17-1000", channel: "APP" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const psids = body.payables.map((p: { psid: string }) => p.psid);
      expect(psids).not.toContain("31010900000181526"); // ETPB's payable — excluded
      expect(psids).toContain("41011300000190123"); // PSCA's payables — still shown
      expect(psids).toContain("41011400000286611");
    } finally {
      await testDb.db.updateTable("agency").set({ status: "ACTIVE" }).where("id", "=", etpb.id).execute();
    }
  });

  it("an assessment past its expiry_date still resolves, reported as status EXPIRED (finding I: 'remains resolvable')", async () => {
    // AS-00041 / PSID 12010500002846133 (FBR-IT-COMP, ISSUED, expiry_date
    // 2026-08-02) — advance the demo clock past that date.
    const before = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": "bank-test-001" },
      payload: { key_type: "PSID", key_value: "12010500002846133", channel: "APP" },
    });
    expect(before.json().payables[0].status).toBe("ISSUED");

    clock.set(new Date("2026-08-03T07:00:00.000Z"));
    try {
      const after = await app.inject({
        method: "POST",
        url: "/v1/resolve",
        headers: { "x-institution-id": "bank-test-001" },
        payload: { key_type: "PSID", key_value: "12010500002846133", channel: "APP" },
      });
      expect(after.statusCode).toBe(200);
      const body = after.json();
      expect(body.payables).toHaveLength(1); // still resolvable, not dropped
      expect(body.payables[0].status).toBe("EXPIRED");
      expect(BigInt(body.payables[0].payable_amount_minor)).toBeGreaterThan(0n); // still has a real amount
    } finally {
      clock.reset();
    }
  });
});
