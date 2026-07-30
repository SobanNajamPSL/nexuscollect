import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import {
  amendAssessment,
  cancelAssessment,
  createAssessment,
  IllegalStateTransition,
  CannotCancelPaidAssessment,
  LineItemsOrphanAllocationError,
  rebuildAssessmentBalance,
} from "../../src/modules/obligation/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * Findings D/F/G: `transition()` guards every assessment state change and
 * appends audit + outbox atomically; `amendAssessment` carries real
 * allocations forward authoritatively (not just a cached total) and surfaces
 * — rather than silently absorbing or rejecting — an amendment that drops
 * below what's already been paid.
 */
describe("Phase 1 findings D/F: obligation module transitions", () => {
  let testDb: TestDb;
  const clock = new DemoClock();
  const actor = { actorType: "INSTITUTION" as const, actorId: "bank-test-001" };

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  async function auditCountFor(entityId: string): Promise<number> {
    const rows = await testDb.db.selectFrom("audit_log").select("id").where("entity_id", "=", entityId).execute();
    return rows.length;
  }
  async function outboxCountFor(aggregateId: string): Promise<number> {
    const rows = await testDb.db.selectFrom("outbox_event").select("id").where("aggregate_id", "=", aggregateId).execute();
    return rows.length;
  }

  it("cancelAssessment on a paid assessment is rejected — CannotCancelPaidAssessment, not a silent no-op", async () => {
    const paid = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", "12010100000485997").executeTakeFirstOrThrow(); // AS-00004, PARTIALLY_PAID
    await expect(cancelAssessment(testDb.db, paid.id, { reasonCode: "ISSUED_IN_ERROR" }, actor, clock)).rejects.toThrow(CannotCancelPaidAssessment);

    const unchanged = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", paid.id).executeTakeFirstOrThrow();
    expect(unchanged.status).toBe("PARTIALLY_PAID"); // untouched
  });

  it("cancelling an unpaid assessment transitions to CANCELLED and appends exactly one audit row and one outbox event", async () => {
    const unpaid = await testDb.db
      .selectFrom("assessment")
      .selectAll()
      .where("status", "=", "ISSUED")
      .where("allocated_amount_minor", "=", 0n)
      .where("psid", "=", "5101150000150") // AS-00104, WASA-WATER-DOM, ISSUED, unallocated
      .executeTakeFirstOrThrow();

    const auditBefore = await auditCountFor(unpaid.id);
    const outboxBefore = await outboxCountFor(unpaid.id);

    await cancelAssessment(testDb.db, unpaid.id, { reasonCode: "DUPLICATE", narrative: "Test-only duplicate" }, actor, clock);

    const after = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", unpaid.id).executeTakeFirstOrThrow();
    expect(after.status).toBe("CANCELLED");
    expect(await auditCountFor(unpaid.id)).toBe(auditBefore + 1);
    expect(await outboxCountFor(unpaid.id)).toBe(outboxBefore + 1);

    const event = await testDb.db
      .selectFrom("outbox_event")
      .selectAll()
      .where("aggregate_id", "=", unpaid.id)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(event.event_type).toBe("assessment.cancelled");
  });

  it("cancelling an already-cancelled assessment is rejected (illegal transition from CANCELLED)", async () => {
    const unpaid = await testDb.db
      .selectFrom("assessment")
      .selectAll()
      .where("status", "=", "ISSUED")
      .where("allocated_amount_minor", "=", 0n)
      .where("psid", "=", "5101150000188") // AS-00107, distinct from the previous test's row
      .executeTakeFirstOrThrow();
    await cancelAssessment(testDb.db, unpaid.id, { reasonCode: "DUPLICATE" }, actor, clock);

    await expect(cancelAssessment(testDb.db, unpaid.id, { reasonCode: "DUPLICATE" }, actor, clock)).rejects.toThrow(IllegalStateTransition);
  });

  it("amending below the allocated amount recognises an overpayment rather than rejecting or corrupting the balance", async () => {
    // AS-00004 / PSID 12010100000485997: PRINCIPAL line amount=49,250,000, allocated=18,896,300.
    const original = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", "12010100000485997").executeTakeFirstOrThrow();
    const oldLines = await testDb.db
      .selectFrom("assessment_line_item")
      .innerJoin("revenue_head", "revenue_head.id", "assessment_line_item.revenue_head_id")
      .select(["assessment_line_item.seq", "assessment_line_item.line_type", "revenue_head.code as revenue_head_code", "assessment_line_item.tax_period", "assessment_line_item.amount_minor", "assessment_line_item.allocation_priority"])
      .where("assessment_id", "=", original.id)
      .orderBy("seq", "asc")
      .execute();

    const newLineItems = oldLines.map((l) => ({
      seq: l.seq,
      lineType: l.line_type,
      revenueHeadCode: l.revenue_head_code,
      taxPeriod: l.tax_period,
      amountMinor: l.line_type === "PRINCIPAL" ? 10_000_000n : l.amount_minor, // drop PRINCIPAL well below its 18,896,300 already allocated
      allocationPriority: l.allocation_priority,
    })) as never;

    const result = await amendAssessment(
      testDb.db,
      original.id,
      { expectedVersion: original.version, reasonCode: "WAIVER_GRANTED", lineItems: newLineItems },
      actor,
      clock,
    );

    // The PRINCIPAL line's real payment_allocation row (18,896,300) no longer
    // fits under its shrunk 10,000,000 capacity, so it stays pointed at the
    // old (superseded but intact) line item rather than being fabricated into
    // a partial split — that whole row becomes the recognised overpayment.
    expect(result.overpaymentRecognisedMinor).toBe(18_896_300n);
    expect(result.balanceMinor).toBeGreaterThanOrEqual(0n); // never goes negative — nothing was force-fit past a line's own capacity
    expect(result.refundId).toBeNull(); // Phase 2 concern — surfaced, not auto-refunded

    const rebuilt = await rebuildAssessmentBalance(testDb.db, result.newAssessmentId);
    expect(rebuilt.matches).toBe(true); // the new version's own cache reconciles with its own (smaller) real allocations
    expect(rebuilt.allocatedFromPaymentAllocations).toBe(rebuilt.allocatedFromLineItems);

    // The abandoned row is still real money, still traceable — just parked on
    // the superseded version's original line item, never deleted.
    const oldPrincipalLine = await testDb.db
      .selectFrom("assessment_line_item")
      .selectAll()
      .where("assessment_id", "=", original.id)
      .where("line_type", "=", "PRINCIPAL")
      .executeTakeFirstOrThrow();
    expect(oldPrincipalLine.allocated_minor).toBe(18_896_300n);
    const orphanedAllocation = await testDb.db
      .selectFrom("payment_allocation")
      .selectAll()
      .where("line_item_id", "=", oldPrincipalLine.id)
      .where("status", "=", "APPLIED")
      .execute();
    expect(orphanedAllocation.reduce((s, r) => s + r.amount_minor, 0n)).toBe(18_896_300n);
  });

  it("amending cannot silently orphan a real allocation by dropping the line type entirely", async () => {
    const original = await testDb.db.selectFrom("assessment").selectAll().where("psid", "=", "12010100000587511").executeTakeFirstOrThrow(); // AS-00005, PARTIALLY_PAID

    await expect(
      amendAssessment(
        testDb.db,
        original.id,
        {
          expectedVersion: original.version,
          reasonCode: "CLERICAL_ERROR",
          lineItems: [{ seq: 1, lineType: "PRINCIPAL", revenueHeadCode: "B01101", taxPeriod: "2025-26", amountMinor: 1_000_000n }],
        },
        actor,
        clock,
      ),
    ).rejects.toThrow(LineItemsOrphanAllocationError);

    const unchanged = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", original.id).executeTakeFirstOrThrow();
    expect(unchanged.status).toBe("PARTIALLY_PAID"); // rolled back entirely, not partially applied
  });

  it("createAssessment inserts real line items that satisfy the sum invariant and appends audit + outbox", async () => {
    const product = await testDb.db.selectFrom("collection_product").selectAll().where("code", "=", "FBR-IT-COMP").executeTakeFirstOrThrow();
    const revenueHead = await testDb.db.selectFrom("revenue_head").selectAll().where("id", "=", product.default_revenue_head_id).executeTakeFirstOrThrow();

    const { id } = await createAssessment(
      testDb.db,
      {
        psid: "12019900099999999",
        agencyId: product.agency_id,
        productId: product.id,
        payerSnapshot: {},
        description: "Test-only assessment (obligation.test.ts)",
        assessedAmountMinor: 500_000n,
        lineItems: [{ seq: 1, lineType: "PRINCIPAL", revenueHeadCode: revenueHead.code, amountMinor: 500_000n }],
        issueDate: "2026-07-01",
        dueDate: "2026-08-01",
        source: "TEST",
      },
      actor,
      clock,
    );

    const row = await testDb.db.selectFrom("assessment").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.status).toBe("ISSUED");
    expect(row.version).toBe(1);
    expect(await auditCountFor(id)).toBe(1);
    expect(await outboxCountFor(id)).toBe(1);

    const lines = await testDb.db.selectFrom("assessment_line_item").select("amount_minor").where("assessment_id", "=", id).execute();
    expect(lines.reduce((s, l) => s + l.amount_minor, 0n)).toBe(500_000n);
  });

  it("createAssessment with mismatched line_items sum fails at COMMIT with LINE_ITEMS_DO_NOT_SUM (finding E)", async () => {
    const product = await testDb.db.selectFrom("collection_product").selectAll().where("code", "=", "FBR-IT-COMP").executeTakeFirstOrThrow();
    const revenueHead = await testDb.db.selectFrom("revenue_head").selectAll().where("id", "=", product.default_revenue_head_id).executeTakeFirstOrThrow();

    await expect(
      createAssessment(
        testDb.db,
        {
          psid: "12019900099999998",
          agencyId: product.agency_id,
          productId: product.id,
          payerSnapshot: {},
          description: "Test-only mismatched-sum assessment",
          assessedAmountMinor: 500_000n,
          lineItems: [{ seq: 1, lineType: "PRINCIPAL", revenueHeadCode: revenueHead.code, amountMinor: 400_000n }], // 100,000 short
          issueDate: "2026-07-01",
          dueDate: "2026-08-01",
          source: "TEST",
        },
        actor,
        clock,
      ),
    ).rejects.toThrow(/LINE_ITEMS_DO_NOT_SUM/);
  });
});
