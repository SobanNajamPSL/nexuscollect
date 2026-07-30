import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../clock/index.js";

/**
 * Transactional outbox (§18): an event is only ever visible to the relay if the
 * business transaction that produced it actually committed. That guarantee comes
 * entirely from the caller — `appendOutboxEvent` must be called with the *same*
 * `trx` handle the business write is using, inside one transaction, never its own
 * transaction. There is no correctness check that can enforce this from inside the
 * function itself; it's an invariant of how it's called (verified by
 * test/integration/outbox.test.ts: a rolled-back transaction leaves no event row).
 */
export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  correlationId?: string;
}

export async function appendOutboxEvent(
  trx: Kysely<Database>,
  event: OutboxEventInput,
  clock: Clock,
): Promise<void> {
  await trx
    .insertInto("outbox_event")
    .values({
      event_id: randomUUID(),
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      sequence: event.sequence,
      event_type: event.eventType,
      // See platform/audit's note: jsonb columns need an explicit JSON.stringify,
      // since node-postgres serialises a bare JS array as a Postgres ARRAY literal
      // instead of JSON.
      payload: JSON.stringify(event.payload) as never,
      correlation_id: event.correlationId ?? null,
      created_at: clock.now(),
      published_at: null,
    })
    .execute();
}

export interface UnpublishedOutboxEvent {
  id: bigint;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  correlationId: string | null;
}

/** For a relay/worker: unpublished events, oldest first. */
export async function fetchUnpublished(
  db: Kysely<Database>,
  limit = 100,
): Promise<UnpublishedOutboxEvent[]> {
  const rows = await db
    .selectFrom("outbox_event")
    .selectAll()
    .where("published_at", "is", null)
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    sequence: row.sequence,
    eventType: row.event_type,
    payload: row.payload,
    correlationId: row.correlation_id,
  }));
}

/** Marks events as published (i.e. handed off to whatever transport delivers them). */
export async function markPublished(db: Kysely<Database>, ids: readonly bigint[], clock: Clock): Promise<void> {
  if (ids.length === 0) return;
  await db.updateTable("outbox_event").set({ published_at: clock.now() }).where("id", "in", ids).execute();
}
