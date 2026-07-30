import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { createAssessment } from "../../src/modules/obligation/index.js";
import { relayOutboxEvents } from "../../src/platform/outbox/relay.js";
import type { UnpublishedOutboxEvent } from "../../src/platform/outbox/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * Finding G: the transactional outbox pattern (§18) proved end to end — a
 * business write and its outbox event commit or roll back together, the
 * relay never sees a row that was never committed, marking published only
 * happens after the callback succeeds, and two concurrent relay workers never
 * double-publish the same batch.
 */
describe("Phase 1 finding G: transactional outbox + relay", () => {
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

  async function makeTestAssessment(psid: string) {
    const product = await testDb.db.selectFrom("collection_product").selectAll().where("code", "=", "FBR-IT-COMP").executeTakeFirstOrThrow();
    const revenueHead = await testDb.db.selectFrom("revenue_head").selectAll().where("id", "=", product.default_revenue_head_id).executeTakeFirstOrThrow();
    return createAssessment(
      testDb.db,
      {
        psid,
        agencyId: product.agency_id,
        productId: product.id,
        payerSnapshot: {},
        description: "Test-only assessment (outbox.test.ts)",
        assessedAmountMinor: 100_000n,
        lineItems: [{ seq: 1, lineType: "PRINCIPAL", revenueHeadCode: revenueHead.code, amountMinor: 100_000n }],
        issueDate: "2026-07-01",
        dueDate: "2026-08-01",
        source: "TEST",
      },
      actor,
      clock,
    );
  }

  it("a business write and its outbox event commit together, and appear exactly once", async () => {
    const { id } = await makeTestAssessment("12019900088888801");
    const events = await testDb.db.selectFrom("outbox_event").selectAll().where("aggregate_id", "=", id).execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("assessment.created");
    expect(events[0]?.published_at).toBeNull();
  });

  it("a rolled-back transaction leaves zero outbox rows — the relay can never see a write that never committed", async () => {
    const product = await testDb.db.selectFrom("collection_product").selectAll().where("code", "=", "FBR-IT-COMP").executeTakeFirstOrThrow();
    const psidMarker = "12019900077777701";
    const aggregateId = crypto.randomUUID();
    const eventId = crypto.randomUUID();

    await expect(
      testDb.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("assessment")
          .values({
            id: aggregateId,
            psid: psidMarker,
            agency_id: product.agency_id,
            product_id: product.id,
            payer_snapshot: JSON.stringify({}) as never,
            description: "Should never persist",
            assessed_amount_minor: 100_000n,
            payable_amount_minor: 100_000n,
            balance_minor: 100_000n,
            issue_date: "2026-07-01",
            due_date: "2026-08-01",
            status: "ISSUED",
            source: "TEST",
          })
          .execute();
        await trx
          .insertInto("outbox_event")
          .values({
            event_id: eventId,
            aggregate_type: "assessment",
            aggregate_id: aggregateId,
            sequence: 1,
            event_type: "assessment.created",
            payload: JSON.stringify({}) as never,
            created_at: clock.now(),
          })
          .execute();
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    const assessmentRows = await testDb.db.selectFrom("assessment").select("id").where("id", "=", aggregateId).execute();
    const outboxRows = await testDb.db.selectFrom("outbox_event").select("id").where("aggregate_id", "=", aggregateId).execute();
    expect(assessmentRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);

    const result = await relayOutboxEvents(testDb.db, async () => {}, clock);
    expect(result.publishedEventIds).not.toContain(eventId);
  });

  it("marks an event published only after the publish callback succeeds", async () => {
    const { id } = await makeTestAssessment("12019900066666601");

    let callCount = 0;
    await expect(
      relayOutboxEvents(
        testDb.db,
        async (event) => {
          callCount++;
          if (event.aggregateId === id) throw new Error("simulated delivery failure");
        },
        clock,
      ),
    ).rejects.toThrow("simulated delivery failure");
    expect(callCount).toBeGreaterThan(0);

    const stillUnpublished = await testDb.db.selectFrom("outbox_event").select("published_at").where("aggregate_id", "=", id).executeTakeFirstOrThrow();
    expect(stillUnpublished.published_at).toBeNull(); // the whole batch's transaction rolled back — nothing falsely marked published

    // A genuinely successful retry then publishes it for real.
    const publishedIds: string[] = [];
    await relayOutboxEvents(
      testDb.db,
      async (event) => {
        publishedIds.push(event.eventId);
      },
      clock,
    );
    const afterRetry = await testDb.db.selectFrom("outbox_event").select("published_at").where("aggregate_id", "=", id).executeTakeFirstOrThrow();
    expect(afterRetry.published_at).not.toBeNull();
  });

  it("retrying the relay after a successful publish is idempotent — nothing gets published twice", async () => {
    await makeTestAssessment("12019900055555501");

    const first = await relayOutboxEvents(testDb.db, async () => {}, clock);
    expect(first.publishedCount).toBeGreaterThan(0);

    const second = await relayOutboxEvents(testDb.db, async () => {}, clock);
    expect(second.publishedCount).toBe(0); // nothing left unpublished
  });

  it("two concurrent relay workers never double-publish the same batch (advisory lock)", async () => {
    await makeTestAssessment("12019900044444401");
    await makeTestAssessment("12019900044444402");

    const seen = new Set<string>();
    const doublyPublished: string[] = [];
    const publish = async (event: UnpublishedOutboxEvent) => {
      await new Promise((r) => setTimeout(r, 20)); // widen the race window
      if (seen.has(event.eventId)) doublyPublished.push(event.eventId);
      seen.add(event.eventId);
    };

    const [a, b] = await Promise.all([relayOutboxEvents(testDb.db, publish, clock), relayOutboxEvents(testDb.db, publish, clock)]);

    expect(doublyPublished).toHaveLength(0);
    // Exactly one of the two workers should have acquired the lock and done the work
    // (the unpublished backlog at this point is whatever's left from earlier tests
    // plus the 2 just inserted — either way, only one worker's count should be nonzero
    // unless there were enough events for both to find something after the first's batch).
    expect(a.lockAcquired || b.lockAcquired).toBe(true);
    if (!a.lockAcquired) expect(a.publishedCount).toBe(0);
    if (!b.lockAcquired) expect(b.publishedCount).toBe(0);
  });
});
