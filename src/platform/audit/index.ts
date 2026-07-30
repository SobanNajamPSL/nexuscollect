import { sql, type Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { computeHashChainLink, verifyChain, type ChainBreak } from "./hash-chain.js";
import type { Clock } from "../clock/index.js";

export { computeHashChainLink, verifyChain, type ChainBreak };

export interface AuditEntryInput {
  actorType: "USER" | "SERVICE" | "SYSTEM" | "INSTITUTION";
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

// Fixed advisory-lock key serialising audit_log chain appends so two concurrent
// writers can never both read the same "last hash" and fork the chain.
const AUDIT_CHAIN_LOCK_KEY = 727_100_001;

function chainableContent(entry: AuditEntryInput): unknown {
  const { actorType, actorId, action, entityType, entityId, beforeJson, afterJson } = entry;
  return { actorType, actorId, action, entityType, entityId, beforeJson, afterJson };
}

/**
 * Appends one hash-chained, append-only audit row. `audit_log` itself additionally
 * rejects UPDATE/DELETE at the database level (CREATE RULE ... DO INSTEAD NOTHING,
 * db/migrations/0011_audit.sql) — this function is simply the only supported way
 * to add to it.
 */
export async function appendAuditEntry(
  db: Kysely<Database>,
  entry: AuditEntryInput,
  clock: Clock,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`.execute(trx);

    const last = await trx
      .selectFrom("audit_log")
      .select("hash_self")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    const hashPrev = last?.hash_self ?? null;
    const hashSelf = computeHashChainLink(chainableContent(entry), hashPrev);

    await trx
      .insertInto("audit_log")
      .values({
        actor_type: entry.actorType,
        actor_id: entry.actorId,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        // JSON.stringify explicitly: a plain JS array would otherwise be sent as a
        // Postgres ARRAY literal by node-postgres's parameter serialisation, not
        // JSON, and rejected by the jsonb column.
        before_json: JSON.stringify(entry.beforeJson ?? null) as never,
        after_json: JSON.stringify(entry.afterJson ?? null) as never,
        ip: entry.ip ?? null,
        user_agent: entry.userAgent ?? null,
        correlation_id: entry.correlationId ?? null,
        occurred_at: clock.now(),
        hash_prev: hashPrev,
        hash_self: hashSelf,
      })
      .execute();
  });
}

/** Walks the whole audit_log chain and names the first tampered row, if any. */
export async function verifyAuditChain(db: Kysely<Database>): Promise<ChainBreak | null> {
  const rows = await db.selectFrom("audit_log").selectAll().orderBy("id", "asc").execute();
  return verifyChain(
    rows,
    (row) => ({
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      beforeJson: row.before_json,
      afterJson: row.after_json,
    }),
    (row) => `audit_log#${row.id}`,
  );
}
