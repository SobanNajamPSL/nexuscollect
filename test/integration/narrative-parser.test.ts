import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { loadSchemeCache, _resetSchemeCacheForTests } from "../../src/modules/resolution/scheme-cache.js";
import { parseNarrative, outcomeToken } from "../../src/modules/resolution/narrative-parser.js";
import expectedResults from "../../demo-data/expected-results.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * §11.6 / §24.5: the narrative parser verified against
 * `demo-data/expected-results.json`'s real, unmodifiable
 * `narrative_parsing_test_corpus` — all 7 stated outcomes, verbatim.
 */
describe("§11.6 narrative parser: the real 7-row corpus", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    _resetSchemeCacheForTests();
    await loadSchemeCache(testDb.db);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  const corpus = expectedResults.narrative_parsing_test_corpus as { narrative: string; expected: string }[];

  it("the corpus itself has exactly 7 rows (the real, unmodified fixture)", () => {
    expect(corpus).toHaveLength(7);
  });

  it("PSID 41011300000190123 INCOME TAX -> AUTO_APPLY_EXACT", async () => {
    const row = corpus.find((r) => r.expected === "AUTO_APPLY_EXACT");
    expect(row).toBeDefined();
    const result = await parseNarrative(testDb.db, { narrative: row!.narrative });
    expect(outcomeToken(result.outcome)).toBe("AUTO_APPLY_EXACT");
  });

  it("TAX PYMT 4101-1300-0001-9012-3 -> AUTO_APPLY_AFTER_NORMALISATION", async () => {
    const row = corpus.find((r) => r.expected === "AUTO_APPLY_AFTER_NORMALISATION");
    expect(row).toBeDefined();
    const result = await parseNarrative(testDb.db, { narrative: row!.narrative });
    expect(outcomeToken(result.outcome)).toBe("AUTO_APPLY_AFTER_NORMALISATION");
  });

  it("RF3741011300000190123 PSCA -> AUTO_APPLY_VIA_RF", async () => {
    const row = corpus.find((r) => r.expected === "AUTO_APPLY_VIA_RF");
    expect(row).toBeDefined();
    const result = await parseNarrative(testDb.db, { narrative: row!.narrative });
    expect(outcomeToken(result.outcome)).toBe("AUTO_APPLY_VIA_RF");
  });

  it("41011300000190124 (corrupted check digit) -> UNAPPLIED_CHECKSUM_FAILED", async () => {
    const row = corpus.find((r) => r.expected === "UNAPPLIED_CHECKSUM_FAILED");
    expect(row).toBeDefined();
    const result = await parseNarrative(testDb.db, { narrative: row!.narrative });
    expect(outcomeToken(result.outcome)).toBe("UNAPPLIED_CHECKSUM_FAILED");
  });

  it("TOKEN TAX LEA 17 1000 (with the real PSCA-CHALLAN-PARK amount) -> REVIEW_QUEUE_SCORE_45", async () => {
    const row = corpus.find((r) => r.expected === "REVIEW_QUEUE_SCORE_45");
    expect(row).toBeDefined();
    // PSCA-CHALLAN-PARK's real payable amount for this vehicle (PSID 41011400000286611) —
    // matching it exactly is what scores this one candidate into the review band;
    // the other two vehicle-linked assessments (ETPB, PSCA-CHALLAN-MOV) score lower.
    const result = await parseNarrative(testDb.db, { narrative: row!.narrative, grossAmountMinor: 300_000n });
    expect(outcomeToken(result.outcome)).toBe("REVIEW_QUEUE_SCORE_45");
  });

  it("TAX PAYMENT AHMED -> UNAPPLIED_BREAK_RAISED", async () => {
    const row = corpus.find((r) => r.expected === "UNAPPLIED_BREAK_RAISED");
    expect(row).toBeDefined();
    const result = await parseNarrative(testDb.db, { narrative: row!.narrative });
    expect(outcomeToken(result.outcome)).toBe("UNAPPLIED_BREAK_RAISED");
  });

  it("PAYMENT FOR 41011300000190123 AND 71011800000183627 -> REVIEW_QUEUE_AMBIGUOUS_NEVER_GUESS", async () => {
    const row = corpus.find((r) => r.expected === "REVIEW_QUEUE_AMBIGUOUS_NEVER_GUESS");
    expect(row).toBeDefined();
    const result = await parseNarrative(testDb.db, { narrative: row!.narrative });
    expect(outcomeToken(result.outcome)).toBe("REVIEW_QUEUE_AMBIGUOUS_NEVER_GUESS");
  });

  it("all 7 corpus rows produce their exact expected outcome in one pass", async () => {
    const amountByNarrative: Record<string, bigint> = { "TOKEN TAX LEA 17 1000": 300_000n };
    for (const row of corpus) {
      const grossAmountMinor = amountByNarrative[row.narrative];
      const result = await parseNarrative(testDb.db, { narrative: row.narrative, ...(grossAmountMinor !== undefined ? { grossAmountMinor } : {}) });
      expect(outcomeToken(result.outcome), row.narrative).toBe(row.expected);
    }
  });
});
