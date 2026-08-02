import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock, DEMO_ANCHOR } from "../../src/platform/clock/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

describe("Prompt 3/4 (scoped): recon route, instrument return route, demo controls", () => {
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

  it("POST /internal/recon/run finds exactly 11 breaks for 2026-07-30", async () => {
    const response = await app.inject({ method: "POST", url: "/internal/recon/run", payload: { business_date: "2026-07-30" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().break_count).toBe(11);
  });

  it("POST /internal/demo/advance-clock moves the demo clock forward", async () => {
    const before = await app.inject({ method: "POST", url: "/internal/demo/advance-clock", payload: { by_ms: 0 } });
    expect(before.json().now).toBe(DEMO_ANCHOR.toISOString());

    const response = await app.inject({ method: "POST", url: "/internal/demo/advance-clock", payload: { by_ms: 24 * 60 * 60 * 1000 } });
    expect(response.statusCode).toBe(200);
    expect(new Date(response.json().now).getTime()).toBe(DEMO_ANCHOR.getTime() + 24 * 60 * 60 * 1000);

    // restore for subsequent tests in this file
    await app.inject({ method: "POST", url: "/internal/demo/advance-clock", payload: { to_iso: DEMO_ANCHOR.toISOString() } });
  });

  it("POST /internal/demo/reset restores seeded state under 10 seconds and the clock resets", async () => {
    // Perturb something first (advance clock + cancel a real assessment).
    await app.inject({ method: "POST", url: "/internal/demo/advance-clock", payload: { by_ms: 60_000 } });
    const before = await testDb.db.selectFrom("assessment").select("id").execute();

    const response = await app.inject({ method: "POST", url: "/internal/demo/reset" });
    expect(response.statusCode).toBe(200);
    expect(response.json().took_ms).toBeLessThan(10_000);

    const after = await testDb.db.selectFrom("assessment").select("id").execute();
    expect(after.length).toBe(before.length); // same real dataset reloaded
    expect(clock.now().toISOString()).toBe(DEMO_ANCHOR.toISOString()); // clock reset too
  });

  it("POST /internal/demo/reset preserves the seeded RBAC demo users and their roles (Phase 11)", async () => {
    // platform_user isn't in BUSINESS_TABLES, but TRUNCATE ... CASCADE on
    // `agency` (which platform_user.agency_id FK-references) wipes it anyway —
    // reset.ts must re-seed it, same as it re-seeds ledger_account.
    await app.inject({ method: "POST", url: "/internal/demo/reset" });

    const users = await testDb.db.selectFrom("platform_user").select(["id", "name"]).execute();
    expect(users.length).toBe(11);
    const bilal = users.find((u) => u.id === "00000000-0000-4000-9000-000000000001");
    expect(bilal?.name).toBe("Bilal Farooq (Agency Admin, ETPB)");

    const roles = await testDb.db.selectFrom("user_role").selectAll().execute();
    expect(roles.length).toBe(11);
    expect(roles.find((r) => r.user_id === "00000000-0000-4000-9000-000000000001")?.role_code).toBe("AGENCY_ADMIN");

    // The two agency-staff personas must come back linked to their tenant, not
    // with a null agency_id: the agency portal scopes every request to the
    // acting user's own agency, so a reset that drops the link would silently
    // leave that portal unable to load anything. `agency` is truncated and
    // reloaded during the reset, so this link can only be restored afterwards.
    const agencyStaff = await testDb.db
      .selectFrom("platform_user")
      .innerJoin("agency", "agency.id", "platform_user.agency_id")
      .select(["platform_user.id", "agency.code"])
      .execute();
    // Two agency staff plus the second administrator added for maker-checker.
    expect(agencyStaff.length).toBe(3);
    expect(agencyStaff.every((u) => u.code === "ETPB")).toBe(true);
  });
});
