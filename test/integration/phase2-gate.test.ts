import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { checkTrialBalance, checkAllocationIntegrity, checkBalanceRebuild, checkLedgerVsSubledger, verifyLedgerChain } from "../../src/modules/control/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * PROMPTS.md Prompt 2's exact gate criteria, verified together against the
 * real, fully-loaded (including the loader-time journal backfill) demo dataset.
 */
describe("Phase 2 gate (PROMPTS.md Prompt 2)", () => {
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

  it("gate: trial balance ties on every business date in the dataset", async () => {
    const dates = await testDb.db.selectFrom("journal_entry").select("value_date").distinct().execute();
    expect(dates.length).toBeGreaterThan(0);
    for (const { value_date } of dates) {
      const result = await checkTrialBalance(testDb.db, value_date);
      expect(result.balanced, `${value_date}: DR ${result.totalDebitMinor} vs CR ${result.totalCreditMinor}`).toBe(true);
    }
  });

  it("gate: for every live payment, applied allocations + unapplied = gross", async () => {
    const result = await checkAllocationIntegrity(testDb.db);
    expect(result.checkedCount).toBeGreaterThan(0);
    expect(result.passed, JSON.stringify(result.breaks, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
  });

  it("gate: balance rebuild produces byte-identical values to the cached columns", async () => {
    const result = await checkBalanceRebuild(testDb.db);
    expect(result.checkedCount).toBeGreaterThan(0);
    expect(result.passed, JSON.stringify(result.breaks)).toBe(true);
  });

  it("gate: ledger-vs-subledger ties across the whole historical dataset", async () => {
    const result = await checkLedgerVsSubledger(testDb.db);
    expect(result.passed, JSON.stringify(result.breaks, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
  });

  it("gate: the hash chain is intact end to end", async () => {
    const chainBreak = await verifyLedgerChain(testDb.db);
    expect(chainBreak).toBeNull();
  });

  it("gate: apply pipeline p99 under 800ms", async () => {
    const SAMPLE_SIZE = 30;
    const durations: number[] = [];
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const start = performance.now();
      const response = await app.inject({
        method: "POST",
        url: "/v1/payments",
        headers: { "x-institution-id": "00000000-0000-4000-8000-000000000003", "idempotency-key": `gate-p99-${i}` },
        payload: { channel: "IBANKING", rail: "RAAST", gross_amount_minor: 100, value_date: "2026-07-30", obligation_discharge_date: "2026-07-30", capture_outcome: "UNCERTAIN" },
      });
      durations.push(performance.now() - start);
      expect(response.statusCode).toBe(201);
    }
    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(durations.length * 0.99)] ?? durations[durations.length - 1];
    expect(p99, `durations: ${durations.map((d) => d.toFixed(1)).join(", ")}`).toBeLessThan(800);
  });
});
