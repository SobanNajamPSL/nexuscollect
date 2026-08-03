import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startTestDb, type TestDb } from "./helpers.js";
import { withAgencyContext } from "../../src/db/client.js";

/**
 * archive/PROMPTS.md Prompt 0, acceptance test 6: "Agency A cannot read agency B's
 * assessment even with a valid PSID." Builds two agencies with one assessment
 * each (minimal fixtures, independent of demo-data) and confirms RLS (§23.1)
 * blocks the cross-tenant read.
 */
describe("Row-level security: cross-agency isolation", () => {
  let testDb: TestDb;
  let agencyAId: string;
  let agencyBId: string;
  let psidB: string;

  beforeAll(async () => {
    testDb = await startTestDb();

    const { db } = testDb;
    const agencyA = await db
      .insertInto("agency")
      .values({
        code: "AG-A",
        name: "Agency A",
        tier: "FEDERAL",
        jurisdiction: "PK",
        legal_entity_name: "Agency A",
        settlement_model: "COLLECTOR_OF_RECORD",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    agencyAId = agencyA.id;

    const agencyB = await db
      .insertInto("agency")
      .values({
        code: "AG-B",
        name: "Agency B",
        tier: "FEDERAL",
        jurisdiction: "PK",
        legal_entity_name: "Agency B",
        settlement_model: "COLLECTOR_OF_RECORD",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    agencyBId = agencyB.id;

    const scheme = await db
      .insertInto("reference_scheme")
      .values({
        code: "SCHEME-B",
        agency_id: agencyBId,
        total_length: 17,
        pattern_regex: "^99[0-9]{15}$",
        checksum_algo: "DAMM",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const head = await db
      .insertInto("revenue_head")
      .values({
        agency_id: agencyBId,
        code: "HEAD-B",
        name: "Head B",
        fund: "FEDERAL_CONSOLIDATED",
        object_class: "TAX_RECEIPT",
        effective_from: "2026-07-01",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const product = await db
      .insertInto("collection_product")
      .values({
        agency_id: agencyBId,
        code: "PRODUCT-B",
        name: "Product B",
        category: "TAX",
        reference_scheme_id: scheme.id,
        amount_rule: "ASSESSED",
        allowed_channels: ["APP"],
        default_revenue_head_id: head.id,
        effective_from: "2026-07-01",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    psidB = "99010100000000019"; // valid-looking 17-digit PSID for agency B
    await db
      .insertInto("assessment")
      .values({
        psid: psidB,
        agency_id: agencyBId,
        product_id: product.id,
        payer_snapshot: JSON.stringify({}) as never,
        description: "Agency B's assessment",
        assessed_amount_minor: 1000n,
        payable_amount_minor: 1000n,
        balance_minor: 1000n,
        issue_date: "2026-07-01",
        due_date: "2026-07-31",
        status: "ISSUED",
        source: "TEST",
      })
      .execute();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  // Note: all three tests below query through `testDb.appDb` (the nexuscollect_app
  // role), never `testDb.db` (the migration/owner role) — Postgres exempts table
  // owners from RLS by default, so asserting against the owner connection would
  // pass or fail for the wrong reason regardless of whether the policies work.

  it("agency A cannot see agency B's assessment even by its exact PSID", async () => {
    const rows = await withAgencyContext(testDb.appDb, { agencyId: agencyAId, isPlatformRole: false }, (trx) =>
      trx.selectFrom("assessment").selectAll().where("psid", "=", psidB).execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it("agency B can see its own assessment", async () => {
    const rows = await withAgencyContext(testDb.appDb, { agencyId: agencyBId, isPlatformRole: false }, (trx) =>
      trx.selectFrom("assessment").selectAll().where("psid", "=", psidB).execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it("the platform role can see across agencies", async () => {
    const rows = await withAgencyContext(testDb.appDb, { isPlatformRole: true }, (trx) =>
      trx.selectFrom("assessment").selectAll().where("psid", "=", psidB).execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it("sanity check: RLS is actually enabled on assessment (not accidentally bypassed)", async () => {
    const { rows } = await sql<{ relrowsecurity: boolean }>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'assessment'
    `.execute(testDb.db);
    expect(rows[0]?.relrowsecurity).toBe(true);
  });
});
