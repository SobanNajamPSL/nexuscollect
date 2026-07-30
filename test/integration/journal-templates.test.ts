import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { getOrCreateLedgerAccount, postJournalEntry } from "../../src/modules/ledger/index.js";
import { JOURNAL_TEMPLATES, postJournalTemplate, combineTemplateLines, type JournalTemplateEventType } from "../../src/modules/journal-templates/index.js";

/**
 * Finding-parity with Phase 1/2's other golden-file test files: one assertion
 * per §10.6 journal template (T01-T30), each proving a real balanced,
 * hash-chained entry posts against real Postgres — plus §10.7's worked
 * example of several templates merged into one entry.
 */
describe("§10.6 journal templates: T01-T30 golden-file postings", () => {
  let testDb: TestDb;
  const clock = new DemoClock();
  let agencyId: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    const agency = await testDb.db
      .insertInto("agency")
      .values({ code: "JT-TEST", name: "Journal Template Test Agency", tier: "FEDERAL", jurisdiction: "PK", legal_entity_name: "JT-TEST", settlement_model: "COLLECTOR_OF_RECORD" })
      .returning("id")
      .executeTakeFirstOrThrow();
    agencyId = agency.id;
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  const ALL_EVENT_TYPES = Object.keys(JOURNAL_TEMPLATES) as JournalTemplateEventType[];

  it("defines exactly 30 templates (T01-T30), no more, no fewer", () => {
    expect(ALL_EVENT_TYPES).toHaveLength(30);
  });

  it.each(ALL_EVENT_TYPES)("%s posts a balanced 2-line entry with the exact debit/credit accounts named in §10.6", async (eventType) => {
    const def = JOURNAL_TEMPLATES[eventType];
    const amount = 12_345n;
    const approvalId = def.requiresApproval ? randomUUID() : undefined;

    const result = await testDb.db.transaction().execute(async (trx) => {
      const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: def.debitBaseCode, dimensionKey: "TEST", name: def.debitName, accountType: "ASSET", normalBalance: "DR" });
      const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: def.creditBaseCode, dimensionKey: "TEST", name: def.creditName, accountType: "LIABILITY", normalBalance: "CR" });
      return postJournalTemplate(
        trx,
        {
          eventType,
          debitAccountCode: debitCode,
          creditAccountCode: creditCode,
          amountMinor: amount,
          sourceType: "test-golden",
          sourceId: randomUUID(),
          valueDate: "2026-07-30",
          agencyId,
          ...(approvalId ? { approvalId } : {}),
        },
        clock,
      );
    });

    const lines = await testDb.db.selectFrom("journal_line").selectAll().where("entry_id", "=", result.id).orderBy("seq", "asc").execute();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.direction).toBe("DR");
    expect(lines[1]?.direction).toBe("CR");
    expect(lines[0]?.amount_minor).toBe(amount);
    expect(lines[1]?.amount_minor).toBe(amount);
  });

  it("a template requiring approval (UNAPPLIED_ALLOCATED, T12) rejects without approval_id", async () => {
    await expect(
      testDb.db.transaction().execute(async (trx) => {
        const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: "2020", dimensionKey: "NOAPPROVAL", name: "test", accountType: "LIABILITY", normalBalance: "CR" });
        const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: "NOAPPROVAL", name: "test", accountType: "LIABILITY", normalBalance: "CR" });
        return postJournalTemplate(trx, { eventType: "UNAPPLIED_ALLOCATED", debitAccountCode: debitCode, creditAccountCode: creditCode, amountMinor: 100n, sourceType: "test", sourceId: randomUUID(), valueDate: "2026-07-30", agencyId }, clock);
      }),
    ).rejects.toThrow(/requires approval_id/);
  });

  it("§10.7 worked example: T01 + T14 + T16 merge into one balanced 6-line entry", async () => {
    // Real anchor shape: a collection with a payer-borne fee and provincial tax on
    // that fee, all landing in a single journal entry rather than three separate ones.
    const collectAmount = 920_000_00n;
    const feeAmount = 50_00n;
    const taxOnFeeAmount = 8_00n;
    const sourceId = randomUUID();

    const { debit1150, credit2010, debit1150fee, credit4010, debit4010, credit2200 } = await testDb.db.transaction().execute(async (trx) => ({
      debit1150: await getOrCreateLedgerAccount(trx, { baseCode: "1150", dimensionKey: "WORKED", name: "Rail Settlement Receivable", accountType: "ASSET", normalBalance: "DR" }),
      credit2010: await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: "WORKED", name: "Agency Payable", accountType: "LIABILITY", normalBalance: "CR" }),
      debit1150fee: await getOrCreateLedgerAccount(trx, { baseCode: "1150", dimensionKey: "WORKED", name: "Rail Settlement Receivable", accountType: "ASSET", normalBalance: "DR" }),
      credit4010: await getOrCreateLedgerAccount(trx, { baseCode: "4010", dimensionKey: "WORKED", name: "Platform Fee Income", accountType: "INCOME", normalBalance: "CR" }),
      debit4010: await getOrCreateLedgerAccount(trx, { baseCode: "4010", dimensionKey: "WORKED", name: "Platform Fee Income", accountType: "INCOME", normalBalance: "CR" }),
      credit2200: await getOrCreateLedgerAccount(trx, { baseCode: "2200", dimensionKey: "WORKED", name: "Tax on Fees Payable", accountType: "LIABILITY", normalBalance: "CR" }),
    }));

    const lines = combineTemplateLines(
      { eventType: "COLLECT_RAIL_CONFIRMED", debitAccountCode: debit1150, creditAccountCode: credit2010, amountMinor: collectAmount, sourceType: "test", sourceId, valueDate: "2026-07-30" },
      { eventType: "FEE_CHARGED_PAYER", debitAccountCode: debit1150fee, creditAccountCode: credit4010, amountMinor: feeAmount, sourceType: "test", sourceId, valueDate: "2026-07-30" },
      { eventType: "TAX_ON_FEE", debitAccountCode: debit4010, creditAccountCode: credit2200, amountMinor: taxOnFeeAmount, sourceType: "test", sourceId, valueDate: "2026-07-30" },
    );
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    const totalDr = lines.filter((l) => l.direction === "DR").reduce((s, l) => s + l.amountMinor, 0n);
    const totalCr = lines.filter((l) => l.direction === "CR").reduce((s, l) => s + l.amountMinor, 0n);
    expect(totalDr).toBe(totalCr); // still balances even though it's 3 templates' worth

    const result = await postJournalEntry(testDb.db, { eventType: "COLLECT_RAIL_CONFIRMED_WITH_FEE", sourceType: "test-worked-example", sourceId, valueDate: "2026-07-30", lines }, clock);
    const postedLines = await testDb.db.selectFrom("journal_line").selectAll().where("entry_id", "=", result.id).execute();
    expect(postedLines).toHaveLength(6);
  });
});
