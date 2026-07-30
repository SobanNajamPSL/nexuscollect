import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { loadSchemeCache } from "../../src/modules/resolution/scheme-cache.js";
import { runReconciliation } from "../../src/modules/recon/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

describe("Phase 3 (scoped): reconciliation engine — the 11-break gate", () => {
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

  it("finds exactly 11 breaks for 2026-07-30, matching the real planted set", async () => {
    const result = await runReconciliation(testDb.db, "2026-07-30", clock);
    console.log("\n--- Break register for 2026-07-30 ---\n" + JSON.stringify(result.breaks.map((b) => ({ code: b.breakCode, type: b.type, amount: b.amountMinor.toString(), ref: b.sourceRef, severity: b.severity, auto: b.autoResolvable })), null, 2));
    expect(result.breaks).toHaveLength(11);
  });

  it("B04 and both B05 rows auto-resolve, raising no alarm", async () => {
    const result = await runReconciliation(testDb.db, "2026-07-30", clock);
    const b04 = result.breaks.filter((b) => b.breakCode === "B04");
    const b05 = result.breaks.filter((b) => b.breakCode === "B05");
    expect(b04.every((b) => b.autoResolvable)).toBe(true);
    expect(b05).toHaveLength(2);
    expect(b05.every((b) => b.autoResolvable && b.severity === "INFO")).toBe(true);
  });

  it("B08 produces exactly one cycle-variance break, not one per transaction", async () => {
    const result = await runReconciliation(testDb.db, "2026-07-30", clock);
    expect(result.breaks.filter((b) => b.breakCode === "B08")).toHaveLength(1);
  });

  it("B09 is classified SCROLL_REJECTED (a classification break), not a cash break", async () => {
    const result = await runReconciliation(testDb.db, "2026-07-30", clock);
    const b09 = result.breaks.find((b) => b.breakCode === "B09");
    expect(b09?.type).toBe("SCROLL_REJECTED");
  });

  it("re-running the run produces identical matches and identical breaks", async () => {
    const first = await runReconciliation(testDb.db, "2026-07-30", clock);
    const second = await runReconciliation(testDb.db, "2026-07-30", clock);
    const summarize = (bs: typeof first.breaks) => bs.map((b) => `${b.breakCode}:${b.sourceRef}:${b.amountMinor}`).sort();
    expect(summarize(second.breaks)).toEqual(summarize(first.breaks));
  });
});
