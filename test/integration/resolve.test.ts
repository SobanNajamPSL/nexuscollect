import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import type pg from "pg";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { loadSchemeCache, _resetSchemeCacheForTests } from "../../src/modules/resolution/scheme-cache.js";
import { resolveReference } from "../../src/modules/resolution/index.js";
import { amendAssessment, rebuildAssessmentBalance, VersionConflictError } from "../../src/modules/obligation/index.js";
import type { Database } from "../../src/db/schema.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * archive/PROMPTS.md Prompt 1's 5 gate criteria, plus the explicit ask to show the
 * LEA-17-1000 resolve response verbatim.
 */
describe("Phase 1: POST /v1/resolve", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock(); // pinned to 2026-07-30T12:00:00+05:00 (§ demo mode)

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  it("gate 1+6: resolves VEHICLE_REG=LEA-17-1000 to exactly the anchor's 3 open + 1 settled, and prints the verbatim response", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": "bank-test-001" },
      payload: { key_type: "VEHICLE_REG", key_value: "LEA-17-1000", channel: "APP" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Prompt 1: "Show me the resolve response for LEA-17-1000 verbatim."
    console.log("\n--- POST /v1/resolve { VEHICLE_REG: LEA-17-1000 } ---\n" + JSON.stringify(body, null, 2) + "\n");

    expect(body.payables).toHaveLength(3);
    expect(body.settled).toHaveLength(1);
    expect(body.resolution_token).toBeTypeOf("string");

    const byPsid = Object.fromEntries(body.payables.map((p: { psid: string }) => [p.psid, p]));
    // demo-data/expected-results.json's demo_walkthrough_anchors.multi_payable_vehicle_lookup
    expect(byPsid["31010900000181526"]).toMatchObject({
      product_code: "ETPB-TOKEN-CAR",
      status: "OVERDUE",
      payable_amount_minor: 1000000,
      discount_applied_minor: 0,
    });
    expect(byPsid["41011300000190123"]).toMatchObject({
      product_code: "PSCA-CHALLAN-MOV",
      status: "ISSUED",
      payable_amount_minor: 375000,
      discount_applied_minor: 125000, // the live 1,250.00 discount
    });
    expect(byPsid["41011400000286611"]).toMatchObject({
      product_code: "PSCA-CHALLAN-PARK",
      status: "OVERDUE",
      payable_amount_minor: 300000,
      discount_applied_minor: 0,
    });

    expect(body.settled[0]).toMatchObject({ psid: "41011400001606295", status: "SETTLED", code: "ALREADY_SETTLED" });
    expect(body.settled[0].receipt_no).toBeTypeOf("string");
    expect(body.settled[0].receipt_no.length).toBeGreaterThan(0);
  });

  it("finding A: all 7 PARTIALLY_PAID fixture assessments resolve to their outstanding balance, not the gross assessed amount", async () => {
    // Expected outstanding = SUM(line.amount_minor) - SUM(line.allocated_minor)
    // per assessment_line_items.csv (neither FBR-IT-COMP nor WASA-WATER-DOM has
    // a live surcharge/discount rule configured, so no derived adjustment applies).
    const expected: Record<string, { psid: string; outstanding: number; gross: number }> = {
      "AS-00004": { psid: "12010100000485997", outstanding: 30353700, gross: 50589500 },
      "AS-00005": { psid: "12010100000587511", outstanding: 27378000, gross: 54756000 },
      "AS-00006": { psid: "12010100000683459", outstanding: 23829000, gross: 59572500 },
      "AS-00007": { psid: "12010100000733644", outstanding: 19556700, gross: 65189000 },
      "AS-00008": { psid: "12010100000831173", outstanding: 41523300, gross: 69205500 },
      "AS-00009": { psid: "12010100000966361", outstanding: 37011000, gross: 74022000 },
      "AS-00092": { psid: "5101150000036", outstanding: 161300, gross: 177000 },
    };

    for (const { psid, outstanding, gross } of Object.values(expected)) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/resolve",
        headers: { "x-institution-id": "bank-test-001" },
        payload: { key_type: "PSID", key_value: psid, channel: "APP" },
      });
      expect(response.statusCode, `PSID ${psid}`).toBe(200);
      const body = response.json();
      expect(body.payables, `PSID ${psid} payables`).toHaveLength(1);
      expect(body.payables[0].payable_amount_minor, `PSID ${psid} payable_amount_minor`).toBe(outstanding);
      expect(body.payables[0].max_payable_minor, `PSID ${psid} max_payable_minor`).toBe(outstanding);
      // Proves it's genuinely the outstanding balance and not a fluke equal to gross.
      expect(body.payables[0].payable_amount_minor, `PSID ${psid} must differ from gross`).not.toBe(gross);
      const lineTotal = body.payables[0].head_breakdown.reduce((s: bigint, l: { balance_minor: number }) => s + BigInt(l.balance_minor), 0n);
      expect(Number(lineTotal), `PSID ${psid} head_breakdown balances must sum to payable_amount_minor`).toBe(outstanding);
    }
  });

  it("gate 2: a bad check digit returns INVALID_REFERENCE_CHECKSUM with zero database queries", async () => {
    // Prime the scheme cache from the real (working) test DB first — cache
    // loading is a startup-time concern, not part of a single resolve call.
    await loadSchemeCache(testDb.db);

    // A pool that throws the instant anything touches it — if resolveReference
    // ever issues a query on the bad-checksum path, this test fails loudly
    // rather than silently passing by coincidence.
    const trapPool = new Proxy({} as pg.Pool, {
      get(_target, prop) {
        throw new Error(`Unexpected DB access via pool.${String(prop)} during offline checksum validation`);
      },
    }) as pg.Pool;
    const trapDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: trapPool }) });

    // 31010900000181526 with its last digit corrupted (a real PSID from the
    // anchor, one digit wrong).
    const outcome = await resolveReference(
      trapDb,
      { keyType: "PSID", keyValue: "31010900000181525", channel: "APP" },
      clock,
    );
    expect(outcome).toEqual({ kind: "INVALID_CHECKSUM" });

    _resetSchemeCacheForTests();
    await loadSchemeCache(testDb.db); // restore for subsequent tests
  });

  it("gate 3: a CNIC lookup without identity_assertion returns 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": "bank-test-001" },
      payload: { key_type: "CNIC", key_value: "3520200000001", channel: "IBANKING" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("gate 3b: the same CNIC lookup with a step-up assertion is allowed through", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": "bank-test-001" },
      payload: {
        key_type: "CNIC",
        key_value: "3520200000001",
        channel: "IBANKING",
        identity_assertion: { asserted_by_institution: true },
      },
    });
    expect(response.statusCode).toBe(200); // not 401 — proceeds to (possibly empty) resolution
  });

  it("gate 4: p99 of POST /v1/resolve is under 300ms against the seeded dataset", async () => {
    const SAMPLE_SIZE = 60;
    const durations: number[] = [];
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const start = performance.now();
      const response = await app.inject({
        method: "POST",
        url: "/v1/resolve",
        headers: { "x-institution-id": "bank-test-001" },
        payload: { key_type: "VEHICLE_REG", key_value: "LEA-17-1000", channel: "APP" },
      });
      durations.push(performance.now() - start);
      expect(response.statusCode).toBe(200);
    }
    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(durations.length * 0.99)] ?? durations[durations.length - 1];
    expect(p99, `durations: ${durations.map((d) => d.toFixed(1)).join(", ")}`).toBeLessThan(300);
  });

  it("gate 5: amending an assessment keeps the PSID, creates version 2, and rebuilds to the exact cached balance (finding D)", async () => {
    // AS-00072 (PSID 41011300000190123) — one of the anchor's open payables.
    const original = await testDb.db
      .selectFrom("assessment")
      .selectAll()
      .where("psid", "=", "41011300000190123")
      .executeTakeFirstOrThrow();
    expect(original.version).toBe(1);

    const result = await amendAssessment(
      testDb.db,
      original.id,
      { expectedVersion: original.version, reasonCode: "CLERICAL_ERROR", description: "Amended: corrected violation code" },
      { actorType: "INSTITUTION", actorId: "bank-test-001" },
      clock,
    );
    expect(result.version).toBe(2);
    expect(result.overpaymentRecognisedMinor).toBe(0n);
    expect(result.refundId).toBeNull();

    const oldRow = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", original.id).executeTakeFirstOrThrow();
    expect(oldRow.status).toBe("AMENDED");

    const newRow = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", result.newAssessmentId).executeTakeFirstOrThrow();
    expect(newRow.psid).toBe(original.psid); // same PSID
    expect(newRow.version).toBe(2);
    expect(newRow.supersedes_id).toBe(original.id);
    expect(newRow.status).toBe("ISSUED");

    // The amended version resolves under the same PSID, and rebuilding its
    // balance from the real allocations reproduces the cached value exactly.
    const response = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": "bank-test-001" },
      payload: { key_type: "PSID", key_value: original.psid, channel: "APP" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().payables[0].psid).toBe(original.psid);

    const rebuilt = await rebuildAssessmentBalance(testDb.db, result.newAssessmentId);
    expect(rebuilt.matches).toBe(true);
    expect(rebuilt.balanceMinor).toBe(newRow.balance_minor);
  });

  it("gate 5b: amending with a stale expected_version is rejected with VERSION_CONFLICT, not silent corruption", async () => {
    const original = await testDb.db
      .selectFrom("assessment")
      .selectAll()
      .where("psid", "=", "41011400000286611")
      .executeTakeFirstOrThrow();

    await expect(
      amendAssessment(
        testDb.db,
        original.id,
        { expectedVersion: original.version + 1, reasonCode: "CLERICAL_ERROR" }, // deliberately stale
        { actorType: "INSTITUTION", actorId: "bank-test-001" },
        clock,
      ),
    ).rejects.toThrow(VersionConflictError);

    const unchanged = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", original.id).executeTakeFirstOrThrow();
    expect(unchanged.status).toBe(original.status);
    expect(unchanged.version).toBe(original.version);
  });
});
