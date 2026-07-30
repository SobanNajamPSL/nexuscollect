import { sql, type Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../clock/index.js";
import { fetchUnpublished, markPublished, type UnpublishedOutboxEvent } from "./index.js";

/**
 * Finding G (audit): `test/integration/outbox.test.ts` was referenced by name
 * in Prompt 1 but this relay never existed. A poll-and-publish loop over the
 * `fetchUnpublished`/`markPublished` primitives that already existed —
 * nothing here builds real delivery/webhook-signing (that's explicitly later
 * phase per §18.2); `publish` is a caller-supplied callback so this stays a
 * thin, generic relay.
 *
 * Runs inside one transaction so `pg_try_advisory_xact_lock` (connection-
 * scoped, auto-released at COMMIT/ROLLBACK) genuinely serialises concurrent
 * relay instances: a second worker that can't acquire the lock returns
 * immediately with an empty result rather than racing the first for the same
 * batch. Marking an event published only happens after `publish` resolves for
 * it, and only commits at all if every event in the batch was handed off
 * successfully — a mid-batch failure rolls the whole transaction back, so
 * nothing in the batch is falsely marked published; the caller's `publish`
 * must be safe to call again next poll (finding G's "retries are idempotent"
 * — enforced by giving the callback a stable `eventId` to dedup on, not by
 * this relay itself withholding retries).
 */
const OUTBOX_RELAY_LOCK_KEY = 727_100_002;

export interface RelayResult {
  publishedCount: number;
  publishedEventIds: string[];
  lockAcquired: boolean;
}

export async function relayOutboxEvents(
  db: Kysely<Database>,
  publish: (event: UnpublishedOutboxEvent) => Promise<void>,
  clock: Clock,
  limit = 100,
): Promise<RelayResult> {
  return db.transaction().execute(async (trx) => {
    const lockRow = await sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(${sql.lit(OUTBOX_RELAY_LOCK_KEY)}) as locked`.execute(trx);
    if (!lockRow.rows[0]?.locked) {
      return { publishedCount: 0, publishedEventIds: [], lockAcquired: false };
    }

    const events = await fetchUnpublished(trx, limit);
    const publishedIds: bigint[] = [];
    const publishedEventIds: string[] = [];
    for (const event of events) {
      await publish(event);
      publishedIds.push(event.id);
      publishedEventIds.push(event.eventId);
    }
    if (publishedIds.length > 0) {
      await markPublished(trx, publishedIds, clock);
    }
    return { publishedCount: publishedIds.length, publishedEventIds, lockAcquired: true };
  });
}
