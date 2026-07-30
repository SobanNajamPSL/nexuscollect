import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { dammValidate } from "../../src/platform/checksum/damm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * PROMPTS.md Prompt 0, acceptance test 9: "All 22 files in demo-data/ load, and
 * all eight generator assertions still hold against the loaded DATABASE (not
 * the CSVs)." scripts/generate_demo_data.py's own verify() runs 17 checks; only
 * some are meaningful against just the 12 master-data tables Phase 0 loads —
 * the rest need recon source files (§12) or business logic (§9 state machines,
 * §11 apply pipeline) that are out of scope until later phases. The ones
 * re-verified here, against the live database:
 *   1  Damm validity of every DAMM-scheme PSID
 *   2  line items sum to assessed_amount_minor
 *   3  per-payment allocation integrity (applied + unapplied = gross)
 *   4  assessment.allocated_amount_minor == sum of applied allocations
 *   5  balance identity (balance = payable - allocated)
 *   11 coverage: 5 waterfalls, >=8 RtP states, 4 instrument statuses, 12 channels, 7 rails
 *   12 PRO_RATA allocation loses/invents no paisa
 *   15 RtP fulfilment is linked in both directions
 *   17 every instrument's type is permitted by its linked assessment's product
 * (checks 6-10, 13-14, 16 need qr-payloads.json / recon source files / scroll
 * data / generator-internal fields not exposed in demo-data/, none of which
 * Phase 0 loads — see demo-data/README.md's own note that those are recon-engine
 * inputs for §12, not master data.)
 */
describe("Demo data: full load + database-side consistency checks", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("loads the documented row counts for all 12 master-data tables", async () => {
    const counts: Record<string, number> = {};
    for (const table of [
      "agency", "revenue_head", "reference_scheme", "collection_product", "payer",
      "payer_account", "assessment", "assessment_line_item", "instrument", "payment",
      "payment_allocation", "request_to_pay",
    ] as const) {
      const { count } = await testDb.db
        .selectFrom(table)
        .select(({ fn }) => fn.countAll().as("count"))
        .executeTakeFirstOrThrow();
      counts[table] = Number(count);
    }
    // demo-data/README.md's headline figures.
    expect(counts).toEqual({
      agency: 9,
      revenue_head: 35,
      reference_scheme: 9,
      collection_product: 20,
      payer: 40,
      payer_account: 27,
      assessment: 164,
      assessment_line_item: 282,
      instrument: 6,
      payment: 115,
      payment_allocation: 218,
      request_to_pay: 14,
    });
  });

  it("check 1: every DAMM-scheme PSID is Damm-valid", async () => {
    const rows = await testDb.db
      .selectFrom("assessment")
      .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
      .innerJoin("reference_scheme", "reference_scheme.id", "collection_product.reference_scheme_id")
      .select(["assessment.psid", "reference_scheme.checksum_algo"])
      .where("reference_scheme.checksum_algo", "=", "DAMM")
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    const invalid = rows.filter((r) => !dammValidate(r.psid));
    expect(invalid, JSON.stringify(invalid)).toEqual([]);
  });

  it("check 2: line items sum to assessed_amount_minor for every assessment", async () => {
    const { rows } = await sql<{ assessment_id: string; psid: string; assessed: string; lines_total: string }>`
      SELECT a.id AS assessment_id, a.psid, a.assessed_amount_minor::text AS assessed,
             COALESCE(SUM(li.amount_minor), 0)::text AS lines_total
      FROM assessment a
      LEFT JOIN assessment_line_item li ON li.assessment_id = a.id
      GROUP BY a.id, a.psid, a.assessed_amount_minor
      HAVING a.assessed_amount_minor <> COALESCE(SUM(li.amount_minor), 0)
    `.execute(testDb.db);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it("check 3: for CONFIRMED payments, applied allocations + unapplied = gross", async () => {
    const { rows } = await sql<{ payment_reference: string; gross: string; unapplied: string; applied: string }>`
      SELECT p.payment_reference, p.gross_amount_minor::text AS gross, p.unapplied_amount_minor::text AS unapplied,
             COALESCE(SUM(pa.amount_minor), 0)::text AS applied
      FROM payment p
      LEFT JOIN payment_allocation pa ON pa.payment_id = p.id AND pa.status = 'APPLIED'
      WHERE p.status = 'CONFIRMED'
      GROUP BY p.id, p.payment_reference, p.gross_amount_minor, p.unapplied_amount_minor
      HAVING p.gross_amount_minor <> (COALESCE(SUM(pa.amount_minor), 0) + p.unapplied_amount_minor)
    `.execute(testDb.db);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it("check 4: assessment.allocated_amount_minor equals the sum of its applied allocations", async () => {
    const { rows } = await sql<{ psid: string; cached: string; actual: string }>`
      SELECT a.psid, a.allocated_amount_minor::text AS cached, COALESCE(SUM(pa.amount_minor), 0)::text AS actual
      FROM assessment a
      LEFT JOIN payment_allocation pa ON pa.assessment_id = a.id AND pa.status = 'APPLIED'
      GROUP BY a.id, a.psid, a.allocated_amount_minor
      HAVING a.allocated_amount_minor <> COALESCE(SUM(pa.amount_minor), 0)
    `.execute(testDb.db);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it("check 5: balance identity (balance = payable - allocated) for every assessment", async () => {
    const { rows } = await sql<{ psid: string }>`
      SELECT psid FROM assessment WHERE balance_minor <> (payable_amount_minor - allocated_amount_minor)
    `.execute(testDb.db);
    expect(rows).toEqual([]);
  });

  it("check 11: coverage — 5 waterfalls, >=8 RtP states, 4 instrument statuses, 12 channels, 7 rails", async () => {
    const waterfalls = await testDb.db.selectFrom("collection_product").select("allocation_waterfall").distinct().execute();
    expect(new Set(waterfalls.map((w) => w.allocation_waterfall))).toEqual(
      new Set(["OLDEST_FIRST", "PENALTY_FIRST", "PRINCIPAL_FIRST", "PRO_RATA", "EXPLICIT_ONLY"]),
    );

    const rtpStates = await testDb.db.selectFrom("request_to_pay").select("status").distinct().execute();
    expect(rtpStates.length).toBeGreaterThanOrEqual(8);

    const instrumentStatuses = await testDb.db.selectFrom("instrument").select("status").distinct().execute();
    expect(instrumentStatuses).toHaveLength(4);

    const channels = await testDb.db.selectFrom("payment").select("channel").distinct().execute();
    expect(channels).toHaveLength(12);

    const rails = await testDb.db.selectFrom("payment").select("rail").distinct().execute();
    expect(rails).toHaveLength(7);
  });

  it("check 12: PRO_RATA allocation loses or invents no paisa", async () => {
    const { rows } = await sql<{ psid: string }>`
      SELECT a.psid FROM assessment a
      LEFT JOIN payment_allocation pa ON pa.assessment_id = a.id AND pa.status = 'APPLIED'
      WHERE a.metadata->>'demoWaterfall' = 'PRO_RATA'
      GROUP BY a.id, a.psid, a.allocated_amount_minor
      HAVING a.allocated_amount_minor <> COALESCE(SUM(pa.amount_minor), 0)
    `.execute(testDb.db);
    expect(rows).toEqual([]);

    const proRataCount = await testDb.db
      .selectFrom("assessment")
      .select(({ fn }) => fn.countAll().as("count"))
      .where(sql`metadata->>'demoWaterfall'`, "=", "PRO_RATA")
      .executeTakeFirstOrThrow();
    expect(Number(proRataCount.count)).toBeGreaterThan(0); // sanity: PRO_RATA is actually exercised
  });

  it("check 15: every FULFILLED(_*) RtP is linked to its payment in both directions", async () => {
    const { rows } = await sql<{ rtp_reference: string; issue: string }>`
      SELECT r.rtp_reference,
        CASE
          WHEN r.fulfilling_payment_id IS NULL THEN 'no fulfilling payment'
          WHEN p.rail_e2e_id IS DISTINCT FROM r.rtp_reference THEN 'EndToEndId != rtp_reference'
        END AS issue
      FROM request_to_pay r
      LEFT JOIN payment p ON p.id = r.fulfilling_payment_id
      WHERE r.status LIKE 'FULFILLED%'
        AND (r.fulfilling_payment_id IS NULL OR p.rail_e2e_id IS DISTINCT FROM r.rtp_reference)
    `.execute(testDb.db);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it("check 17: every instrument's type is permitted by its linked assessment's product", async () => {
    const { rows } = await sql<{
      instrument_id: string;
      instrument_type: string;
      allowed_instruments: string[];
    }>`
      SELECT DISTINCT ON (i.id) i.id AS instrument_id, i.instrument_type, cp.allowed_instruments
      FROM instrument i
      JOIN instrument_link il ON il.instrument_id = i.id
      JOIN assessment a ON a.id = il.assessment_id
      JOIN collection_product cp ON cp.id = a.product_id
      ORDER BY i.id, il.id
    `.execute(testDb.db);
    expect(rows.length).toBeGreaterThan(0);
    const disallowed = rows.filter((r) => !r.allowed_instruments.includes(r.instrument_type));
    expect(disallowed, JSON.stringify(disallowed)).toEqual([]);
  });
});
