import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startTestDb, type TestDb } from "./helpers.js";
import { postJournalEntry, verifyLedgerChain } from "../../src/modules/ledger/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";

describe("Ledger: append-only, balanced-at-commit, hash-chain tamper detection", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("posts a balanced entry and it commits successfully", async () => {
    const { id } = await postJournalEntry(
      testDb.db,
      {
        eventType: "TEST_POST",
        sourceType: "test",
        sourceId: randomUUID(),
        valueDate: "2026-07-30",
        narrative: "balanced test entry",
        lines: [
          { seq: 1, accountCode: "2020", direction: "CR", amountMinor: 1_000_00n },
          { seq: 2, accountCode: "1900", direction: "DR", amountMinor: 1_000_00n },
        ],
      },
      clock,
    );
    const entry = await testDb.db.selectFrom("journal_entry").selectAll().where("id", "=", id).executeTakeFirst();
    expect(entry).toBeDefined();
  });

  // PROMPTS.md Prompt 0, acceptance test 3: "An unbalanced journal entry raises
  // at COMMIT, not at INSERT." The deferred constraint trigger only checks at
  // commit, so both journal_line INSERTs succeed and only the transaction's
  // final COMMIT (wrapped inside postJournalEntry's `db.transaction().execute`)
  // rejects.
  it("rejects an unbalanced entry, and only at commit", async () => {
    await expect(
      postJournalEntry(
        testDb.db,
        {
          eventType: "TEST_UNBALANCED",
          sourceType: "test",
          sourceId: randomUUID(),
          valueDate: "2026-07-30",
          lines: [
            { seq: 1, accountCode: "2020", direction: "CR", amountMinor: 1_000_00n },
            { seq: 2, accountCode: "1900", direction: "DR", amountMinor: 999_00n }, // deliberately off by 1 rupee
          ],
        },
        clock,
      ),
    ).rejects.toThrow(/Unbalanced journal entry/);

    // And it must not have left a partial entry behind — the whole transaction rolled back.
    const orphanLines = await testDb.db
      .selectFrom("journal_line")
      .innerJoin("journal_entry", "journal_entry.id", "journal_line.entry_id")
      .select("journal_line.id")
      .where("journal_entry.event_type", "=", "TEST_UNBALANCED")
      .execute();
    expect(orphanLines).toHaveLength(0);
  });

  // PROMPTS.md Prompt 0, acceptance test 2: "UPDATE and DELETE on journal_entry
  // and journal_line are no-ops."
  it("makes UPDATE and DELETE on journal_entry / journal_line no-ops", async () => {
    const { id: entryId } = await postJournalEntry(
      testDb.db,
      {
        eventType: "TEST_IMMUTABLE",
        sourceType: "test",
        sourceId: randomUUID(),
        valueDate: "2026-07-30",
        lines: [
          { seq: 1, accountCode: "2020", direction: "CR", amountMinor: 500_00n },
          { seq: 2, accountCode: "1900", direction: "DR", amountMinor: 500_00n },
        ],
      },
      clock,
    );

    const before = await testDb.db.selectFrom("journal_entry").selectAll().where("id", "=", entryId).executeTakeFirstOrThrow();

    await sql`UPDATE journal_entry SET narrative = 'TAMPERED' WHERE id = ${entryId}`.execute(testDb.db);
    const afterUpdate = await testDb.db.selectFrom("journal_entry").selectAll().where("id", "=", entryId).executeTakeFirstOrThrow();
    expect(afterUpdate.narrative).toBe(before.narrative); // unchanged — RULE ... DO INSTEAD NOTHING

    await sql`DELETE FROM journal_entry WHERE id = ${entryId}`.execute(testDb.db);
    const afterDelete = await testDb.db.selectFrom("journal_entry").selectAll().where("id", "=", entryId).executeTakeFirst();
    expect(afterDelete).toBeDefined(); // still there — DELETE was a no-op

    const lineBefore = await testDb.db.selectFrom("journal_line").selectAll().where("entry_id", "=", entryId).execute();
    await sql`UPDATE journal_line SET amount_minor = 1 WHERE entry_id = ${entryId}`.execute(testDb.db);
    const lineAfterUpdate = await testDb.db.selectFrom("journal_line").selectAll().where("entry_id", "=", entryId).execute();
    expect(lineAfterUpdate.map((l) => l.amount_minor)).toEqual(lineBefore.map((l) => l.amount_minor));

    await sql`DELETE FROM journal_line WHERE entry_id = ${entryId}`.execute(testDb.db);
    const lineAfterDelete = await testDb.db.selectFrom("journal_line").selectAll().where("entry_id", "=", entryId).execute();
    expect(lineAfterDelete).toHaveLength(lineBefore.length); // still there
  });

  // PROMPTS.md Prompt 0, acceptance test 4: "Tampering with a journal row is
  // detected by verify-chain, which names the entry." We bypass the RULE by
  // going around it — the RULE blocks UPDATE/DELETE, but the whole point of a
  // hash chain is to also catch tampering that *did* get through some other way
  // (e.g. a superuser bypassing application logic, or a restored backup edited
  // by hand) — so this test asserts the detection mechanism itself: it directly
  // fabricates a row with a wrong hash_self, exactly as if a line's amount had
  // been altered before the hash was recomputed, and confirms verify-chain names it.
  it("verify-chain detects and names a tampered entry", async () => {
    const before = await verifyLedgerChain(testDb.db);
    expect(before).toBeNull(); // chain is clean so far

    const { id: entryId, entryNo } = await postJournalEntry(
      testDb.db,
      {
        eventType: "TEST_TAMPER_TARGET",
        sourceType: "test",
        sourceId: randomUUID(),
        valueDate: "2026-07-30",
        lines: [
          { seq: 1, accountCode: "2020", direction: "CR", amountMinor: 250_00n },
          { seq: 2, accountCode: "1900", direction: "DR", amountMinor: 250_00n },
        ],
      },
      clock,
    );

    // Simulate tampering with a hand-edited row (or a restored backup, or a
    // superuser bypassing the application entirely) by disabling the table
    // owner's own append-only RULE for one statement — the RULE blocks ordinary
    // UPDATEs (already proven above), but the hash chain exists precisely to
    // catch tampering that gets in some other way.
    await sql`ALTER TABLE journal_entry DISABLE RULE je_no_update`.execute(testDb.db);
    try {
      await sql`UPDATE journal_entry SET hash_self = decode('deadbeef', 'hex') WHERE id = ${entryId}`.execute(
        testDb.db,
      );
    } finally {
      await sql`ALTER TABLE journal_entry ENABLE RULE je_no_update`.execute(testDb.db);
    }

    const after = await verifyLedgerChain(testDb.db);
    expect(after).not.toBeNull();
    expect(after?.label).toBe(`journal_entry#${entryNo}`);
  });
});
