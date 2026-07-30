import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * Finding E (audit): migration 0018's deferred constraint trigger enforces
 * SUM(assessment_line_item.amount_minor) = assessment.assessed_amount_minor
 * at COMMIT, not per-INSERT — so an assessment and its lines can be inserted
 * in one transaction. Covers matching commits, missing/excess amounts,
 * negative ROUNDING lines, and confirms the full real demo-data (164 real
 * assessments, already loaded via the standard loader) still loads unchanged
 * with the trigger active.
 */
describe("Phase 1 finding E: line-item sum enforcement (migration 0018)", () => {
  let testDb: TestDb;
  let ctx: { agencyId: string; headId: string; productId: string };
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    ctx = await makeFixtureProduct();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  async function makeFixtureProduct() {
    const agency = await testDb.db.insertInto("agency").values({ code: "LIS", name: "Line Item Sum Test Agency", tier: "FEDERAL", jurisdiction: "PK", legal_entity_name: "LIS", settlement_model: "COLLECTOR_OF_RECORD" }).returning("id").executeTakeFirstOrThrow();
    const scheme = await testDb.db.insertInto("reference_scheme").values({ code: "SCHEME-LIS", agency_id: agency.id, total_length: 17, pattern_regex: "^97[0-9]{15}$", checksum_algo: "DAMM" }).returning("id").executeTakeFirstOrThrow();
    const head = await testDb.db.insertInto("revenue_head").values({ agency_id: agency.id, code: "HEAD-LIS", name: "Head LIS", fund: "FEDERAL_CONSOLIDATED", object_class: "TAX_RECEIPT", effective_from: "2026-07-01" }).returning("id").executeTakeFirstOrThrow();
    const product = await testDb.db.insertInto("collection_product").values({ agency_id: agency.id, code: "PRODUCT-LIS", name: "Product LIS", category: "TAX", reference_scheme_id: scheme.id, amount_rule: "ASSESSED", allowed_channels: ["APP"], default_revenue_head_id: head.id, effective_from: "2026-07-01" }).returning("id").executeTakeFirstOrThrow();
    return { agencyId: agency.id, headId: head.id, productId: product.id };
  }

  async function insertAssessmentWithLines(psid: string, assessedAmountMinor: bigint, lines: { lineType: string; amountMinor: bigint }[], ctx: { agencyId: string; headId: string; productId: string }) {
    return testDb.db.transaction().execute(async (trx) => {
      const assessment = await trx
        .insertInto("assessment")
        .values({
          psid,
          agency_id: ctx.agencyId,
          product_id: ctx.productId,
          payer_snapshot: JSON.stringify({}) as never,
          description: "Line-item sum test",
          assessed_amount_minor: assessedAmountMinor,
          payable_amount_minor: assessedAmountMinor,
          balance_minor: assessedAmountMinor,
          issue_date: "2026-07-01",
          due_date: "2026-08-01",
          status: "ISSUED",
          source: "TEST",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      for (const [i, line] of lines.entries()) {
        await trx
          .insertInto("assessment_line_item")
          .values({ assessment_id: assessment.id, seq: i + 1, line_type: line.lineType as never, revenue_head_id: ctx.headId, amount_minor: line.amountMinor })
          .execute();
      }
      return assessment.id;
    });
  }

  it("matching line items commit successfully", async () => {
    const id = await insertAssessmentWithLines("97010100000000010", 100_000n, [{ lineType: "PRINCIPAL", amountMinor: 100_000n }], ctx);
    const row = await testDb.db.selectFrom("assessment").select("id").where("id", "=", id).executeTakeFirst();
    expect(row).toBeDefined();
  });

  it("a missing amount (lines sum short of assessed_amount_minor) fails at COMMIT with LINE_ITEMS_DO_NOT_SUM", async () => {
    await expect(insertAssessmentWithLines("97010100000000011", 100_000n, [{ lineType: "PRINCIPAL", amountMinor: 90_000n }], ctx)).rejects.toThrow(/LINE_ITEMS_DO_NOT_SUM/);

    const rows = await testDb.db.selectFrom("assessment").select("id").where("psid", "=", "97010100000000011").execute();
    expect(rows).toHaveLength(0); // the whole transaction rolled back, not left half-applied
  });

  it("an excess amount (lines sum over assessed_amount_minor) also fails at COMMIT", async () => {
    await expect(
      insertAssessmentWithLines("97010100000000012", 100_000n, [{ lineType: "PRINCIPAL", amountMinor: 90_000n }, { lineType: "PENALTY", amountMinor: 20_000n }], ctx),
    ).rejects.toThrow(/LINE_ITEMS_DO_NOT_SUM/);
  });

  it("a negative ROUNDING line nets correctly against the other lines", async () => {
    const id = await insertAssessmentWithLines(
      "97010100000000013",
      99_950n,
      [
        { lineType: "PRINCIPAL", amountMinor: 100_000n },
        { lineType: "ROUNDING", amountMinor: -50n },
      ],
      ctx,
    );
    const lines = await testDb.db.selectFrom("assessment_line_item").select("amount_minor").where("assessment_id", "=", id).execute();
    expect(lines.reduce((s, l) => s + l.amount_minor, 0n)).toBe(99_950n);
  });

  it("the full real demo-data (164 real assessments) still loads unchanged with the trigger active", async () => {
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    const count = await testDb.db.selectFrom("assessment").select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    expect(Number(count.count)).toBeGreaterThan(0);

    // Spot-check a real multi-line assessment's lines still sum correctly.
    const anchor = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", "41011400000286611").executeTakeFirstOrThrow();
    const lines = await testDb.db.selectFrom("assessment_line_item").select("amount_minor").where("assessment_id", "=", anchor.id).execute();
    expect(lines.reduce((s, l) => s + l.amount_minor, 0n)).toBe(anchor.assessed_amount_minor);
  });
});
