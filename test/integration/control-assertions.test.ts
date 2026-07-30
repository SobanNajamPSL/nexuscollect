import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { capturePayment } from "../../src/modules/payment/index.js";
import { checkTrialBalance, checkAllocationIntegrity, checkBalanceRebuild, checkLedgerVsSubledger, verifyLedgerChain } from "../../src/modules/control/index.js";
import { loadSchemeCache } from "../../src/modules/resolution/scheme-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * §10.8's five control assertions. `allocation-integrity` and
 * `balance-rebuild` are meaningful against the real 115 historical payments/
 * allocations the loader already establishes (no journal entries needed —
 * both check payment/assessment/allocation consistency directly). Real
 * ledger entries for those 115 historical payments come from the loader-time
 * journal backfill (a separate piece); `trial-balance` and
 * `ledger-vs-subledger` are proven here against journal entries this test
 * itself posts via the real apply pipeline.
 */
describe("§10.8 control assertions", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    await loadSchemeCache(testDb.db);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("allocation-integrity passes against the real, already-loaded historical payments, with its exclusion set stated explicitly", async () => {
    const result = await checkAllocationIntegrity(testDb.db);
    expect(result.excludedStatuses).toEqual(["REVERSED", "UNCERTAIN"]);
    expect(result.checkedCount).toBeGreaterThan(0);
    expect(result.passed, JSON.stringify(result.breaks, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
  });

  it("balance-rebuild passes across every real assessment already in demo-data", async () => {
    const result = await checkBalanceRebuild(testDb.db);
    expect(result.checkedCount).toBeGreaterThan(0);
    expect(result.passed, JSON.stringify(result.breaks, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
  });

  it("trial-balance ties after processing real payments through the apply pipeline", async () => {
    await capturePayment(testDb.db, { paymentReference: "CTRLTEST0001", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 300_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", remittanceRaw: "PSID 41011400000286611 PARKING CHALLAN", captureOutcome: "CONFIRMED" }, clock);
    await capturePayment(testDb.db, { paymentReference: "CTRLTEST0002", channel: "IBANKING", rail: "RAAST", grossAmountMinor: 1_000_000n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", remittanceRaw: "PSID 31010900000181526 TOKEN TAX", captureOutcome: "CONFIRMED" }, clock);

    const result = await checkTrialBalance(testDb.db, "2026-07-30");
    expect(result.totalDebitMinor).toBeGreaterThan(0n);
    expect(result.balanced, `DR ${result.totalDebitMinor} vs CR ${result.totalCreditMinor}`).toBe(true);
  });

  it("ledger-vs-subledger ties per agency, including the real historical allocations the loader-time journal backfill now posts real entries for", async () => {
    const result = await checkLedgerVsSubledger(testDb.db);
    expect(result.checkedAgencyCount).toBeGreaterThan(0);
    expect(result.passed, JSON.stringify(result.breaks, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
  });

  it("verify-chain reports intact on a clean chain, then names the exact tampered entry", async () => {
    const before = await verifyLedgerChain(testDb.db);
    expect(before).toBeNull();

    const anyEntry = await testDb.db.selectFrom("journal_entry").select(["id", "entry_no"]).orderBy("entry_no", "asc").limit(1).executeTakeFirstOrThrow();
    await sql`ALTER TABLE journal_entry DISABLE RULE je_no_update`.execute(testDb.db);
    try {
      await sql`UPDATE journal_entry SET hash_self = decode('deadbeef', 'hex') WHERE id = ${anyEntry.id}`.execute(testDb.db);
    } finally {
      await sql`ALTER TABLE journal_entry ENABLE RULE je_no_update`.execute(testDb.db);
    }

    const after = await verifyLedgerChain(testDb.db);
    expect(after).not.toBeNull();
    expect(after?.label).toBe(`journal_entry#${anyEntry.entry_no}`);
  });
});
