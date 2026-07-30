import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { withAgencyContext } from "../../src/db/client.js";

/**
 * Finding P (audit): 0013_row_level_security.sql left assessment_line_item,
 * payment_allocation, and instrument_link unprotected. Migration 0020 closes
 * that via a join back to each row's parent agency_id. Proves Agency A can't
 * read Agency B's child rows through the non-owner `nexuscollect_app` role —
 * by direct table scan, by joining through the parent, and by resolving the
 * parent's own PSID.
 */
describe("Row-level security: child tables (assessment_line_item, payment_allocation, instrument_link)", () => {
  let testDb: TestDb;
  let agencyAId: string;
  let agencyBId: string;
  let assessmentBId: string;
  let lineItemBId: string;
  let paymentAllocationBId: string;
  let instrumentBId: string;
  let instrumentLinkBId: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    const { db } = testDb;

    const [agencyA, agencyB] = await Promise.all([
      db.insertInto("agency").values({ code: "AG-A2", name: "Agency A2", tier: "FEDERAL", jurisdiction: "PK", legal_entity_name: "Agency A2", settlement_model: "COLLECTOR_OF_RECORD" }).returning("id").executeTakeFirstOrThrow(),
      db.insertInto("agency").values({ code: "AG-B2", name: "Agency B2", tier: "FEDERAL", jurisdiction: "PK", legal_entity_name: "Agency B2", settlement_model: "COLLECTOR_OF_RECORD" }).returning("id").executeTakeFirstOrThrow(),
    ]);
    agencyAId = agencyA.id;
    agencyBId = agencyB.id;

    const scheme = await db
      .insertInto("reference_scheme")
      .values({ code: "SCHEME-B2", agency_id: agencyBId, total_length: 17, pattern_regex: "^98[0-9]{15}$", checksum_algo: "DAMM" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const head = await db
      .insertInto("revenue_head")
      .values({ agency_id: agencyBId, code: "HEAD-B2", name: "Head B2", fund: "FEDERAL_CONSOLIDATED", object_class: "TAX_RECEIPT", effective_from: "2026-07-01" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const product = await db
      .insertInto("collection_product")
      .values({ agency_id: agencyBId, code: "PRODUCT-B2", name: "Product B2", category: "TAX", reference_scheme_id: scheme.id, amount_rule: "ASSESSED", allowed_channels: ["APP"], default_revenue_head_id: head.id, effective_from: "2026-07-01" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const assessment = await db
      .insertInto("assessment")
      .values({
        psid: "98010100000000018",
        agency_id: agencyBId,
        product_id: product.id,
        payer_snapshot: JSON.stringify({}) as never,
        description: "Agency B2's assessment",
        assessed_amount_minor: 1000n,
        payable_amount_minor: 1000n,
        allocated_amount_minor: 1000n,
        balance_minor: 0n,
        issue_date: "2026-07-01",
        due_date: "2026-07-31",
        status: "SETTLED",
        source: "TEST",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    assessmentBId = assessment.id;

    const lineItem = await db
      .insertInto("assessment_line_item")
      .values({ assessment_id: assessmentBId, seq: 1, line_type: "PRINCIPAL", revenue_head_id: head.id, amount_minor: 1000n, allocated_minor: 1000n })
      .returning("id")
      .executeTakeFirstOrThrow();
    lineItemBId = lineItem.id;

    const payment = await db
      .insertInto("payment")
      .values({
        payment_reference: "PAY-RLS-TEST-B2",
        channel: "APP",
        rail: "RAAST",
        gross_amount_minor: 1000n,
        net_to_agency_minor: 1000n,
        value_date: "2026-07-01",
        obligation_discharge_date: "2026-07-01",
        status: "CONFIRMED",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const allocation = await db
      .insertInto("payment_allocation")
      .values({ payment_id: payment.id, assessment_id: assessmentBId, line_item_id: lineItemBId, revenue_head_id: head.id, amount_minor: 1000n, allocation_basis: "EXPLICIT" })
      .returning("id")
      .executeTakeFirstOrThrow();
    paymentAllocationBId = allocation.id;

    const instrument = await db
      .insertInto("instrument")
      .values({ instrument_type: "CHEQUE", instrument_number: "RLS-TEST-001", amount_minor: 1000n, agency_id: agencyBId, status: "LODGED" })
      .returning("id")
      .executeTakeFirstOrThrow();
    instrumentBId = instrument.id;

    const link = await db
      .insertInto("instrument_link")
      .values({ instrument_id: instrumentBId, assessment_id: assessmentBId, amount_minor: 1000n })
      .returning("id")
      .executeTakeFirstOrThrow();
    instrumentLinkBId = link.id;
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("assessment_line_item: agency A cannot see agency B's line items; agency B can; platform role can", async () => {
    const asA = await withAgencyContext(testDb.appDb, { agencyId: agencyAId, isPlatformRole: false }, (trx) => trx.selectFrom("assessment_line_item").selectAll().where("id", "=", lineItemBId).execute());
    expect(asA).toHaveLength(0);

    const asB = await withAgencyContext(testDb.appDb, { agencyId: agencyBId, isPlatformRole: false }, (trx) => trx.selectFrom("assessment_line_item").selectAll().where("id", "=", lineItemBId).execute());
    expect(asB).toHaveLength(1);

    const asPlatform = await withAgencyContext(testDb.appDb, { isPlatformRole: true }, (trx) => trx.selectFrom("assessment_line_item").selectAll().where("id", "=", lineItemBId).execute());
    expect(asPlatform).toHaveLength(1);
  });

  it("payment_allocation: agency A cannot see agency B's allocations even via the PSID join", async () => {
    const asA = await withAgencyContext(testDb.appDb, { agencyId: agencyAId, isPlatformRole: false }, (trx) =>
      trx.selectFrom("payment_allocation").innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id").selectAll("payment_allocation").where("assessment.psid", "=", "98010100000000018").execute(),
    );
    expect(asA).toHaveLength(0);

    const asB = await withAgencyContext(testDb.appDb, { agencyId: agencyBId, isPlatformRole: false }, (trx) => trx.selectFrom("payment_allocation").selectAll().where("id", "=", paymentAllocationBId).execute());
    expect(asB).toHaveLength(1);
  });

  it("instrument_link: agency A cannot see agency B's instrument link; agency B can", async () => {
    const asA = await withAgencyContext(testDb.appDb, { agencyId: agencyAId, isPlatformRole: false }, (trx) => trx.selectFrom("instrument_link").selectAll().where("id", "=", instrumentLinkBId).execute());
    expect(asA).toHaveLength(0);

    const asB = await withAgencyContext(testDb.appDb, { agencyId: agencyBId, isPlatformRole: false }, (trx) => trx.selectFrom("instrument_link").selectAll().where("id", "=", instrumentLinkBId).execute());
    expect(asB).toHaveLength(1);
  });

  it("receipt (already RLS-protected since migration 0016) still isolates correctly alongside the new child-table policies", async () => {
    // Sanity check that adding the new policies didn't disturb the existing one.
    const asA = await withAgencyContext(testDb.appDb, { agencyId: agencyAId, isPlatformRole: false }, (trx) => trx.selectFrom("receipt").selectAll().where("agency_id", "=", agencyBId).execute());
    expect(asA).toHaveLength(0);
  });
});
