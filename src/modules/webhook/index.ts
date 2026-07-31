import { createHmac, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { fetchUnpublished, markPublished, type UnpublishedOutboxEvent } from "../../platform/outbox/index.js";

/**
 * §18.2's webhook delivery contract, built on top of `platform/outbox`'s
 * already-existing generic relay primitives (`fetchUnpublished`/
 * `markPublished`) rather than a second event-sourcing mechanism.
 */

// §18.2: "Exponential backoff: 0s, 30s, 2m, 10m, 1h, 6h, 24h — then dead-letter."
const RETRY_SCHEDULE_MS = [0, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000];
const CIRCUIT_BREAKER_THRESHOLD = 100; // §18.2's own [A] marker — configurable, not hardcoded as fact
const DELIVERY_TIMEOUT_MS = 5_000;

export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

/** Verifies against BOTH the current and previous secret (§18.2: "two active
 * secrets during rotation; sign with both") — a consumer-side utility,
 * published so an agency's integration code can use the identical check. */
export function verifySignature(header: string, body: string, secrets: readonly string[]): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  if (!match) return false;
  const [, tsStr, sig] = match;
  const expected = Buffer.from(sig!, "hex");
  for (const secret of secrets) {
    const candidate = Buffer.from(createHmac("sha256", secret).update(`${tsStr}.${body}`).digest("hex"), "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

export interface WebhookSender {
  (url: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number }>;
}

/** Real HTTP delivery via Node 22's native `fetch`, with the 5s timeout §18.2 specifies. */
export const httpSender: WebhookSender = async (url, body, headers) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", body, headers, signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timeout);
  }
};

async function attemptDelivery(
  db: Kysely<Database>,
  subscription: { id: string; url: string; secret_current: string; secret_previous: string | null; consecutive_failures: number },
  event: UnpublishedOutboxEvent,
  send: WebhookSender,
  clock: Clock,
): Promise<void> {
  const existing = await db.selectFrom("webhook_delivery").selectAll().where("subscription_id", "=", subscription.id).where("event_id", "=", event.eventId).executeTakeFirst();
  const attemptNo = existing?.attempt_no ?? 0;
  if (existing && existing.status !== "PENDING") return; // already resolved (DELIVERED/DEAD_LETTERED) — at-least-once, but skip a settled delivery

  const body = JSON.stringify({ event_id: event.eventId, event_type: event.eventType, aggregate_type: event.aggregateType, aggregate_id: event.aggregateId, sequence: event.sequence, payload: event.payload });
  const timestampSeconds = Math.floor(clock.now().getTime() / 1000);
  const signature = signPayload(subscription.secret_current, timestampSeconds, body);

  const result = await send(subscription.url, body, { "content-type": "application/json", "x-signature": signature, "x-event-id": event.eventId });

  if (result.ok) {
    await db
      .insertInto("webhook_delivery")
      .values({ subscription_id: subscription.id, event_id: event.eventId, attempt_no: attemptNo, status: "DELIVERED", next_attempt_at: clock.now(), last_response_code: result.status, delivered_at: clock.now() })
      .onConflict((oc) => oc.columns(["subscription_id", "event_id"]).doUpdateSet({ status: "DELIVERED", last_response_code: result.status, delivered_at: clock.now() }))
      .execute();
    await db.updateTable("webhook_subscription").set({ consecutive_failures: 0 }).where("id", "=", subscription.id).execute();
    return;
  }

  const nextAttemptNo = attemptNo + 1;
  const isDead = nextAttemptNo >= RETRY_SCHEDULE_MS.length;
  const nextAttemptAt = new Date(clock.now().getTime() + (RETRY_SCHEDULE_MS[Math.min(nextAttemptNo, RETRY_SCHEDULE_MS.length - 1)] ?? 0));

  await db
    .insertInto("webhook_delivery")
    .values({ subscription_id: subscription.id, event_id: event.eventId, attempt_no: nextAttemptNo, status: isDead ? "DEAD_LETTERED" : "PENDING", next_attempt_at: nextAttemptAt, last_response_code: result.status || null, last_error: result.status === 0 ? "timeout or connection error" : `HTTP ${result.status}` })
    .onConflict((oc) => oc.columns(["subscription_id", "event_id"]).doUpdateSet({ attempt_no: nextAttemptNo, status: isDead ? "DEAD_LETTERED" : "PENDING", next_attempt_at: nextAttemptAt, last_response_code: result.status || null }))
    .execute();

  const newFailureCount = subscription.consecutive_failures + 1;
  await db
    .updateTable("webhook_subscription")
    .set({ consecutive_failures: newFailureCount, ...(newFailureCount >= CIRCUIT_BREAKER_THRESHOLD ? { status: "SUSPENDED" } : {}) })
    .where("id", "=", subscription.id)
    .execute();
}

export interface DeliverBatchResult {
  attempted: number;
  delivered: number;
}

/** Delivers every unpublished outbox event to every ACTIVE subscription
 * whose next retry is due, then marks the outbox events published — mirrors
 * `relayOutboxEvents`'s own shape but fans out per-subscription instead of a
 * single generic callback, since a webhook event can have multiple
 * subscribers with independent retry clocks. */
export async function deliverPendingWebhooks(db: Kysely<Database>, clock: Clock, send: WebhookSender = httpSender, limit = 100): Promise<DeliverBatchResult> {
  const events = await fetchUnpublished(db, limit);
  const subscriptions = await db.selectFrom("webhook_subscription").selectAll().where("status", "=", "ACTIVE").execute();

  let delivered = 0;
  let attempted = 0;
  for (const event of events) {
    for (const sub of subscriptions) {
      const pendingRow = await db.selectFrom("webhook_delivery").select(["status", "next_attempt_at"]).where("subscription_id", "=", sub.id).where("event_id", "=", event.eventId).executeTakeFirst();
      if (pendingRow && (pendingRow.status !== "PENDING" || pendingRow.next_attempt_at > clock.now())) continue;
      attempted++;
      await attemptDelivery(db, sub, event, send, clock);
      const after = await db.selectFrom("webhook_delivery").select("status").where("subscription_id", "=", sub.id).where("event_id", "=", event.eventId).executeTakeFirst();
      if (after?.status === "DELIVERED") delivered++;
    }
  }

  if (events.length > 0) {
    await markPublished(db, events.map((e) => e.id), clock);
  }

  return { attempted, delivered };
}

/** §18.2: "POST /admin/v1/webhooks/{id}/replay?from=&to= for consumer
 * recovery" — re-queues delivery rows for events already recorded against
 * this subscription within the window, resetting them to PENDING/attempt 0. */
export async function replayWebhooks(db: Kysely<Database>, subscriptionId: string, fromEventSeq: number, toEventSeq: number, clock: Clock): Promise<number> {
  const rows = await db
    .selectFrom("webhook_delivery as wd")
    .innerJoin("outbox_event as oe", "oe.event_id", "wd.event_id")
    .select("wd.id")
    .where("wd.subscription_id", "=", subscriptionId)
    .where("oe.sequence", ">=", fromEventSeq)
    .where("oe.sequence", "<=", toEventSeq)
    .execute();
  if (rows.length === 0) return 0;
  await db.updateTable("webhook_delivery").set({ status: "PENDING", attempt_no: 0, next_attempt_at: clock.now() }).where("id", "in", rows.map((r) => r.id)).execute();
  return rows.length;
}

export async function createWebhookSubscription(db: Kysely<Database>, url: string, secret: string, agencyId?: string): Promise<string> {
  const inserted = await db.insertInto("webhook_subscription").values({ url, secret_current: secret, ...(agencyId ? { agency_id: agencyId } : {}) }).returning("id").executeTakeFirstOrThrow();
  return inserted.id;
}
