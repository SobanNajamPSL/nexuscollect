import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import { computeHashChainLink, verifyChain, type ChainBreak } from "../../platform/audit/hash-chain.js";
import type { Clock } from "../../platform/clock/index.js";

/**
 * The minimum slice of §10 "Ledger & Accounting Design" that Phase 0's own
 * acceptance tests require to exist: posting a hash-chained, balanced journal
 * entry, and `verify-chain` to prove tampering is detectable. This is NOT the
 * apply pipeline (§11) — no allocation, no waterfalls, no journal templates T01-T30.
 * Those are Phase 2. This module exists so Phase 0's tests 2, 3 and 4 (append-only,
 * balanced-at-commit, tamper-detection) have something real to exercise.
 */

export interface JournalLineInput {
  seq: number;
  accountCode: string;
  direction: "DR" | "CR";
  amountMinor: bigint;
  currency?: string;
  revenueHeadId?: string;
  dimension?: Record<string, unknown>;
}

export interface PostJournalEntryInput {
  eventType: string;
  sourceType: string;
  sourceId: string;
  sequence?: number;
  agencyId?: string;
  valueDate: string; // YYYY-MM-DD, Asia/Karachi business date (§0.2 rule 8)
  narrative?: string;
  correlationId?: string;
  approvalId?: string;
  lines: readonly JournalLineInput[];
}

// Fixed advisory-lock key serialising journal_entry chain appends — same rationale
// as platform/audit's AUDIT_CHAIN_LOCK_KEY, a different constant so the two chains
// never contend with each other.
const LEDGER_CHAIN_LOCK_KEY = 727_100_002;

function chainableLineContent(line: JournalLineInput) {
  return {
    seq: line.seq,
    accountCode: line.accountCode,
    direction: line.direction,
    amountMinor: line.amountMinor.toString(),
    currency: line.currency ?? "PKR",
    revenueHeadId: line.revenueHeadId ?? null,
    dimension: line.dimension ?? {},
  };
}

/**
 * Posts one journal entry. Balance is NOT checked here in application code — it is
 * enforced by the database's deferred constraint trigger (assert_entry_balanced,
 * db/migrations/0007_ledger.sql), which fires once at COMMIT after every line for
 * this entry has been inserted, so an unbalanced entry raises at COMMIT rather than
 * on the first INSERT (Phase 0 acceptance test #3).
 *
 * hash_self is computed and included in the journal_entry INSERT itself, not added
 * afterwards, because journal_entry has no UPDATE path at all (§10.5's RULE ...
 * DO INSTEAD NOTHING) — so entry_no and the line content must both be known before
 * that one INSERT happens.
 *
 * Idempotent on `(source_type, source_id, event_type, sequence)` (§10.2: "this is
 * what lets you safely re-run a failed apply job"). On a replay, the INSERT is a
 * no-op (`ON CONFLICT DO NOTHING`) and the already-posted entry is returned
 * verbatim — the caller never gets a duplicate entry or a thrown unique-violation.
 *
 * Takes whatever handle the caller passes — a plain `Kysely<Database>` or an
 * already-open `Transaction<Database>` — and only opens its own transaction
 * when it isn't already inside one (mirrors `platform/audit`'s
 * `appendAuditEntry` fix for the same nested-transaction problem). This is
 * what lets `modules/journal-templates`' `postJournalTemplate` be called from
 * within a caller's own transaction (e.g. the apply pipeline posting several
 * templates alongside allocation writes, all atomically).
 */
export async function postJournalEntry(
  db: Kysely<Database>,
  input: PostJournalEntryInput,
  clock: Clock,
): Promise<{ id: string; entryNo: bigint; replayed: boolean }> {
  const run = async (trx: Transaction<Database>) => {
    await sql`SELECT pg_advisory_xact_lock(${LEDGER_CHAIN_LOCK_KEY})`.execute(trx);

    const existing = await trx
      .selectFrom("journal_entry")
      .select(["id", "entry_no"])
      .where("source_type", "=", input.sourceType)
      .where("source_id", "=", input.sourceId)
      .where("event_type", "=", input.eventType)
      .where("sequence", "=", input.sequence ?? 1)
      .executeTakeFirst();
    if (existing) {
      return { id: existing.id, entryNo: existing.entry_no, replayed: true };
    }

    const last = await trx
      .selectFrom("journal_entry")
      .select("hash_self")
      .orderBy("entry_no", "desc")
      .limit(1)
      .executeTakeFirst();
    const hashPrev = last?.hash_self ?? null;

    const { rows } = await sql<{
      nextval: string;
    }>`SELECT nextval('journal_entry_entry_no_seq') AS nextval`.execute(trx);
    const entryNo = BigInt(rows[0]?.nextval ?? (() => { throw new Error("could not allocate entry_no"); })());

    const lineContents = [...input.lines]
      .sort((a, b) => a.seq - b.seq)
      .map((l) => chainableLineContent(l));
    const hashSelf = computeHashChainLink({ entryNo: entryNo.toString(), lines: lineContents }, hashPrev);

    const id = randomUUID();
    await trx
      .insertInto("journal_entry")
      .values({
        id,
        entry_no: entryNo,
        event_type: input.eventType,
        source_type: input.sourceType,
        source_id: input.sourceId,
        sequence: input.sequence ?? 1,
        agency_id: input.agencyId ?? null,
        value_date: input.valueDate,
        posted_at: clock.now(),
        narrative: input.narrative ?? null,
        approval_id: input.approvalId ?? null,
        correlation_id: input.correlationId ?? null,
        hash_prev: hashPrev,
        hash_self: hashSelf,
      })
      .execute();

    for (const line of input.lines) {
      await trx
        .insertInto("journal_line")
        .values({
          entry_id: id,
          seq: line.seq,
          account_code: line.accountCode,
          direction: line.direction,
          amount_minor: line.amountMinor,
          currency: line.currency ?? "PKR",
          revenue_head_id: line.revenueHeadId ?? null,
          dimension: JSON.stringify(line.dimension ?? {}) as never,
        })
        .execute();
    }

    return { id, entryNo, replayed: false };
  };

  return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run);
}

export interface LedgerAccountDimension {
  baseCode: string;
  dimensionKey: string;
  name: string;
  accountType: "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY" | "MEMO";
  normalBalance: "DR" | "CR";
  agencyId?: string;
}

/**
 * §10.3 flags certain accounts (`1010`,`1020`,`1030`,`1100`,`1150`,`1200`,`1300`,
 * `2010`,`2015`,`2030`,`2040`) as carrying a "{branch}"/"{bank}"/"{rail}"/
 * "{agent}"/"{agency}" placeholder — one account per real-world instance of that
 * dimension, instantiated on demand rather than pre-seeded (Phase 0's migration
 * 0014 seeds only the singular accounts and leaves this comment explaining why).
 * The account code itself carries the dimension (`2010-FBR`), matching the
 * migration's own worked example — deterministic, so no read-then-decide race:
 * `ON CONFLICT (code) DO NOTHING` is always safe.
 */
export async function getOrCreateLedgerAccount(trx: Transaction<Database>, dim: LedgerAccountDimension): Promise<string> {
  const code = `${dim.baseCode}-${dim.dimensionKey}`;
  await trx
    .insertInto("ledger_account")
    .values({
      code,
      name: `${dim.name} — ${dim.dimensionKey}`,
      account_type: dim.accountType,
      normal_balance: dim.normalBalance,
      agency_id: dim.agencyId ?? null,
    })
    .onConflict((oc) => oc.column("code").doNothing())
    .execute();
  return code;
}

/**
 * Walks the whole journal_entry chain (oldest first) and names the first entry
 * whose stored hash_self no longer matches what its (possibly tampered) content
 * recomputes to. Backs `GET /internal/ledger/verify-chain` (§10.4).
 */
export async function verifyLedgerChain(db: Kysely<Database>): Promise<ChainBreak | null> {
  const entries = await db.selectFrom("journal_entry").selectAll().orderBy("entry_no", "asc").execute();
  const lines = await db.selectFrom("journal_line").selectAll().orderBy("entry_id", "asc").orderBy("seq", "asc").execute();

  const linesByEntry = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = linesByEntry.get(line.entry_id) ?? [];
    list.push(line);
    linesByEntry.set(line.entry_id, list);
  }

  return verifyChain(
    entries,
    (entry) => ({
      entryNo: entry.entry_no.toString(),
      lines: (linesByEntry.get(entry.id) ?? []).map((l) => chainableLineContent({
        seq: l.seq,
        accountCode: l.account_code,
        direction: l.direction,
        amountMinor: l.amount_minor,
        currency: l.currency,
        // exactOptionalPropertyTypes: omit the key entirely rather than set it to
        // `undefined` — chainableLineContent normalises either way to `null`.
        ...(l.revenue_head_id ? { revenueHeadId: l.revenue_head_id } : {}),
        dimension: l.dimension as Record<string, unknown>,
      })),
    }),
    (entry) => `journal_entry#${entry.entry_no}`,
  );
}
