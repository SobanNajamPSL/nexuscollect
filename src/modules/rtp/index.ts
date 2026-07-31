import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";

/**
 * §9.2's full 15-state Request to Pay machine. Every transition goes through
 * `transitionRtp`, mirroring `modules/obligation`'s `transition()` pattern:
 * a guarded UPDATE (illegal moves fail before touching the row) plus an
 * audit row and an outbox event in the same transaction.
 *
 * `request_to_pay` has no `reminder_of_id` column (only `reminder_count`), so
 * a reminder is modelled as returning the SAME row to `SENT` with a fresh
 * `expires_at` rather than creating a new linked row — the schema's own
 * shape, not an invented mechanism.
 */

export type RtpStatus =
  | "CREATED" | "SENT" | "DELIVERED" | "PRESENTED"
  | "ACCEPTED" | "ACCEPTED_FUTURE_DATED" | "ACCEPTED_PARTIAL"
  | "FULFILLED" | "FULFILLED_PARTIAL" | "FULFILLED_LATE"
  | "DECLINED" | "EXPIRED" | "CANCELLED" | "FAILED" | "UNDELIVERABLE";

export type RtpEvent =
  | "rtp.sent" | "rtp.delivered" | "rtp.undeliverable" | "rtp.failed"
  | "rtp.presented" | "rtp.accepted" | "rtp.accepted_future_dated" | "rtp.accepted_partial"
  | "rtp.declined" | "rtp.expired" | "rtp.cancelled"
  | "rtp.fulfilled" | "rtp.fulfilled_partial" | "rtp.fulfilled_late" | "rtp.reminded";

const ALLOWED_TRANSITIONS: Record<RtpEvent, readonly RtpStatus[]> = {
  "rtp.sent": ["CREATED"],
  "rtp.delivered": ["SENT"],
  "rtp.undeliverable": ["SENT"],
  "rtp.failed": ["SENT"],
  "rtp.presented": ["DELIVERED"],
  "rtp.accepted": ["PRESENTED"],
  "rtp.accepted_future_dated": ["PRESENTED"],
  "rtp.accepted_partial": ["PRESENTED"],
  "rtp.declined": ["PRESENTED"],
  "rtp.expired": ["SENT", "DELIVERED", "PRESENTED"],
  "rtp.cancelled": ["CREATED", "SENT", "DELIVERED", "PRESENTED", "ACCEPTED", "ACCEPTED_FUTURE_DATED", "ACCEPTED_PARTIAL"],
  "rtp.fulfilled": ["ACCEPTED", "ACCEPTED_FUTURE_DATED"],
  "rtp.fulfilled_partial": ["ACCEPTED_PARTIAL"],
  "rtp.fulfilled_late": ["EXPIRED"],
  "rtp.reminded": ["EXPIRED"],
};

const TARGET_STATUS: Record<RtpEvent, RtpStatus> = {
  "rtp.sent": "SENT",
  "rtp.delivered": "DELIVERED",
  "rtp.undeliverable": "UNDELIVERABLE",
  "rtp.failed": "FAILED",
  "rtp.presented": "PRESENTED",
  "rtp.accepted": "ACCEPTED",
  "rtp.accepted_future_dated": "ACCEPTED_FUTURE_DATED",
  "rtp.accepted_partial": "ACCEPTED_PARTIAL",
  "rtp.declined": "DECLINED",
  "rtp.expired": "EXPIRED",
  "rtp.cancelled": "CANCELLED",
  "rtp.fulfilled": "FULFILLED",
  "rtp.fulfilled_partial": "FULFILLED_PARTIAL",
  "rtp.fulfilled_late": "FULFILLED_LATE",
  "rtp.reminded": "SENT",
};

export class IllegalRtpTransition extends Error {
  readonly httpStatus = 409;
  readonly code = "ILLEGAL_STATE_TRANSITION";
  constructor(event: RtpEvent, from: string) {
    super(`Illegal RtP transition: cannot apply "${event}" to a request in status ${from}`);
    this.name = "IllegalRtpTransition";
  }
}

export interface Actor {
  actorType: "USER" | "SERVICE" | "SYSTEM" | "INSTITUTION";
  actorId: string;
}

async function nextOutboxSequence(trx: Transaction<Database>, aggregateType: string, aggregateId: string): Promise<number> {
  const row = await trx
    .selectFrom("outbox_event")
    .select(({ fn }) => fn.max("sequence").as("max_seq"))
    .where("aggregate_type", "=", aggregateType)
    .where("aggregate_id", "=", aggregateId)
    .executeTakeFirst();
  return Number(row?.max_seq ?? 0) + 1;
}

export interface TransitionOptions {
  /** Additional columns to SET alongside `status` (e.g. decline_reason_code, fulfilling_payment_id). */
  patch?: Record<string, unknown>;
  eventPayload?: unknown;
  correlationId?: string;
}

/**
 * §9.2's own instruction, transcribed literally: guarded transition + audit + outbox.
 * Returns the row's `rtp_reference` and resulting status for convenience.
 */
export async function transitionRtp(
  trx: Transaction<Database>,
  rtpId: string,
  event: RtpEvent,
  actor: Actor,
  clock: Clock,
  opts: TransitionOptions = {},
): Promise<{ rtpReference: string; status: RtpStatus }> {
  const before = await trx
    .selectFrom("request_to_pay")
    .selectAll()
    .where("id", "=", rtpId)
    .executeTakeFirstOrThrow();

  if (!ALLOWED_TRANSITIONS[event].includes(before.status as RtpStatus)) {
    throw new IllegalRtpTransition(event, before.status);
  }

  const to = TARGET_STATUS[event];
  const result = await trx
    .updateTable("request_to_pay")
    .set({ status: to, ...(opts.patch ?? {}) })
    .where("id", "=", rtpId)
    .where("status", "=", before.status)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0n) !== 1) {
    throw new IllegalRtpTransition(event, before.status);
  }

  const after = await trx.selectFrom("request_to_pay").selectAll().where("id", "=", rtpId).executeTakeFirstOrThrow();

  // §6.1's own rule ("money is bigint, never a JSON number") also governs the
  // audit trail: `amount_minor` is serialised as a decimal string, same as
  // every other money-carrying JSON boundary in this codebase.
  const toAuditSnapshot = (row: typeof before) => ({ ...row, amount_minor: row.amount_minor.toString() });

  const sequence = await nextOutboxSequence(trx, "request_to_pay", rtpId);
  await appendAuditEntry(
    trx,
    {
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: event,
      entityType: "request_to_pay",
      entityId: rtpId,
      beforeJson: toAuditSnapshot(before),
      afterJson: toAuditSnapshot(after),
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    },
    clock,
  );
  await appendOutboxEvent(
    trx,
    {
      aggregateType: "request_to_pay",
      aggregateId: rtpId,
      sequence,
      eventType: event,
      payload: opts.eventPayload ?? { rtp_reference: before.rtp_reference, from: before.status, to },
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    },
    clock,
  );

  return { rtpReference: before.rtp_reference, status: to };
}

export async function markSent(trx: Transaction<Database>, rtpId: string, railMsgId: string, actor: Actor, clock: Clock) {
  return transitionRtp(trx, rtpId, "rtp.sent", actor, clock, { patch: { rail_msg_id: railMsgId } });
}

export async function markDelivered(trx: Transaction<Database>, rtpId: string, actor: Actor, clock: Clock) {
  return transitionRtp(trx, rtpId, "rtp.delivered", actor, clock);
}

export async function markUndeliverable(trx: Transaction<Database>, rtpId: string, reasonCode: string, actor: Actor, clock: Clock) {
  return transitionRtp(trx, rtpId, "rtp.undeliverable", actor, clock, { patch: { decline_reason_code: reasonCode } });
}

export async function markPresented(trx: Transaction<Database>, rtpId: string, actor: Actor, clock: Clock) {
  return transitionRtp(trx, rtpId, "rtp.presented", actor, clock);
}

export type AcceptMode = "FULL" | "FUTURE_DATED" | "PARTIAL";

/** §9.2: PRESENTED → ACCEPTED / ACCEPTED_FUTURE_DATED / ACCEPTED_PARTIAL. */
export async function acceptRtp(
  trx: Transaction<Database>,
  rtpId: string,
  mode: AcceptMode,
  actor: Actor,
  clock: Clock,
  acceptedAmountMinor?: bigint,
): Promise<{ rtpReference: string; status: RtpStatus }> {
  if (mode === "PARTIAL") {
    const row = await trx.selectFrom("request_to_pay").select(["amount_modifiable", "amount_minor"]).where("id", "=", rtpId).executeTakeFirstOrThrow();
    if (!row.amount_modifiable) {
      throw new Error("This RtP does not permit a modified amount (amount_modifiable = false)");
    }
    if (acceptedAmountMinor === undefined || acceptedAmountMinor <= 0n || acceptedAmountMinor >= row.amount_minor) {
      throw new Error("A partial acceptance must specify an accepted amount strictly less than the requested amount");
    }
    return transitionRtp(trx, rtpId, "rtp.accepted_partial", actor, clock, { patch: { amount_minor: acceptedAmountMinor } });
  }
  const event: RtpEvent = mode === "FUTURE_DATED" ? "rtp.accepted_future_dated" : "rtp.accepted";
  return transitionRtp(trx, rtpId, event, actor, clock);
}

export async function declineRtp(trx: Transaction<Database>, rtpId: string, reasonCode: string, actor: Actor, clock: Clock) {
  return transitionRtp(trx, rtpId, "rtp.declined", actor, clock, { patch: { decline_reason_code: reasonCode } });
}

export async function cancelRtp(trx: Transaction<Database>, rtpId: string, reasonCode: string, actor: Actor, clock: Clock) {
  return transitionRtp(trx, rtpId, "rtp.cancelled", actor, clock, { patch: { decline_reason_code: reasonCode } });
}

/** A sweep-style helper: any RtP still in SENT/DELIVERED/PRESENTED past its
 * `expires_at` (per the injected clock, never the real one) moves to EXPIRED
 * with no response received — matches §9.2's "no response ► EXPIRED" arrow. */
export async function expireDueRequests(db: Kysely<Database>, clock: Clock): Promise<string[]> {
  const now = clock.now();
  const due = await db
    .selectFrom("request_to_pay")
    .select(["id"])
    .where("status", "in", ["SENT", "DELIVERED", "PRESENTED"])
    .where("expires_at", "<", now)
    .execute();
  const expiredRefs: string[] = [];
  for (const row of due) {
    await db.transaction().execute(async (trx) => {
      const result = await transitionRtp(trx, row.id, "rtp.expired", { actorType: "SYSTEM", actorId: "rtp-expiry-sweep" }, clock);
      expiredRefs.push(result.rtpReference);
    });
  }
  return expiredRefs;
}

/** §9.2: EXPIRED ──remind──► (same row returns to SENT, a fresh cycle). */
export async function remindRtp(trx: Transaction<Database>, rtpId: string, newExpiresAt: Date, actor: Actor, clock: Clock) {
  const row = await trx.selectFrom("request_to_pay").select(["reminder_count"]).where("id", "=", rtpId).executeTakeFirstOrThrow();
  return transitionRtp(trx, rtpId, "rtp.reminded", actor, clock, {
    patch: { expires_at: newExpiresAt, reminder_count: row.reminder_count + 1 },
  });
}

/**
 * Links a captured payment back onto its originating RtP, per §9.2's
 * ACCEPTED/ACCEPTED_FUTURE_DATED → FULFILLED, ACCEPTED_PARTIAL → FULFILLED_PARTIAL,
 * and — per §9.3's "must still accept a late credit" rule applied to RtP —
 * EXPIRED → FULFILLED_LATE when the credit arrives after expiry.
 * Called by the switch adapter's `notify` step (§8.6) after a successful capture.
 */
export async function fulfillRtpWithPayment(trx: Transaction<Database>, rtpId: string, paymentId: string, actor: Actor, clock: Clock) {
  const row = await trx.selectFrom("request_to_pay").select(["status"]).where("id", "=", rtpId).executeTakeFirstOrThrow();
  const event: RtpEvent =
    row.status === "ACCEPTED_PARTIAL" ? "rtp.fulfilled_partial"
    : row.status === "EXPIRED" ? "rtp.fulfilled_late"
    : "rtp.fulfilled";
  return transitionRtp(trx, rtpId, event, actor, clock, { patch: { fulfilling_payment_id: paymentId } });
}
