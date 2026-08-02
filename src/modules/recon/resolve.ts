import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";

/**
 * Break resolution under maker-checker.
 *
 * `recon_break` has carried `status`, `resolution_type`, `approval_id`,
 * `resolved_at` and `resolved_by_user_id` since migration 0009, and every one of
 * them was unused: reconciliation could *find* the eleven breaks but nothing in
 * the platform could resolve one. The Break Register screen only ever displayed
 * them, which hid the gap — it looked finished.
 *
 * §3.2 segregates the two roles deliberately: OPS_RECON_ANALYST proposes a
 * resolution, OPS_RECON_APPROVER approves it, and they can never be the same
 * person. That's enforced here and again by the `approval` table's own
 * segregation constraint, so it holds regardless of which code path is used —
 * the same belt-and-braces approach the ledger takes.
 *
 * Status vocabulary (the column has no CHECK constraint, so this is a disclosed
 * choice rather than a documented one):
 *   OPEN → PENDING_APPROVAL → RESOLVED
 *                          ↘ OPEN  (rejected, back to the analyst)
 * `RESOLVED` is also what an auto-resolvable break is written as directly by the
 * recon run itself, so the register's "resolved" filter means one thing.
 */

/**
 * How a break can legitimately be closed. Derived from what the eleven seeded
 * breaks actually are — a timing difference is accepted, a treasury rejection is
 * reclassified rather than treated as missing cash, a fee variance below
 * tolerance is written off — not invented from a standards document.
 */
export const RESOLUTION_TYPES = [
  "MANUAL_MATCH",
  "ACCEPT_TIMING",
  "RECLASSIFY",
  "WRITE_OFF",
  "ESCALATE_TO_AGENCY",
] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

export class BreakNotOpenError extends Error {
  readonly httpStatus = 409;
  readonly code = "BREAK_NOT_OPEN";
  constructor(breakId: string, status: string) {
    super(`Break ${breakId} is ${status}, not OPEN — only an open break can have a resolution proposed.`);
    this.name = "BreakNotOpenError";
  }
}

export class BreakNotPendingError extends Error {
  readonly httpStatus = 409;
  readonly code = "BREAK_NOT_PENDING_APPROVAL";
  constructor(breakId: string, status: string) {
    super(`Break ${breakId} is ${status}, not PENDING_APPROVAL — there is no proposal to act on.`);
    this.name = "BreakNotPendingError";
  }
}

export class SelfApprovalNotAllowedError extends Error {
  readonly httpStatus = 409;
  readonly code = "SELF_APPROVAL_NOT_ALLOWED";
  constructor() {
    super(
      "The analyst who proposed this resolution cannot also approve it — §3.2 segregates the analyst and approver roles, and the database enforces it.",
    );
    this.name = "SelfApprovalNotAllowedError";
  }
}

export interface ProposeInput {
  breakId: string;
  resolutionType: ResolutionType;
  narrative: string;
  makerUserId: string;
}

export async function proposeBreakResolution(
  db: Kysely<Database>,
  input: ProposeInput,
  clock: Clock,
): Promise<{ approvalId: string }> {
  return db.transaction().execute(async (trx) => {
    const brk = await trx.selectFrom("recon_break").selectAll().where("id", "=", input.breakId).executeTakeFirstOrThrow();
    if (brk.status !== "OPEN") throw new BreakNotOpenError(input.breakId, brk.status);

    const approval = await trx
      .insertInto("approval")
      .values({
        subject_type: "recon_break",
        subject_id: input.breakId,
        action: `RESOLVE_BREAK_${input.resolutionType}`,
        amount_minor: brk.amount_minor,
        payload: JSON.stringify({
          breakCode: brk.break_code,
          resolutionType: input.resolutionType,
          narrative: input.narrative,
        }) as never,
        maker_user_id: input.makerUserId,
        maker_at: clock.now(),
        state: "PENDING",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("recon_break")
      .set({
        status: "PENDING_APPROVAL",
        resolution_type: input.resolutionType,
        approval_id: approval.id,
        assigned_to_user_id: input.makerUserId,
      })
      .where("id", "=", input.breakId)
      .execute();

    await appendAuditEntry(
      trx,
      {
        actorType: "USER",
        actorId: input.makerUserId,
        action: "recon_break.resolution_proposed",
        entityType: "recon_break",
        entityId: input.breakId,
        beforeJson: { status: brk.status },
        afterJson: { status: "PENDING_APPROVAL", resolutionType: input.resolutionType, narrative: input.narrative },
      },
      clock,
    );
    await appendOutboxEvent(
      trx,
      {
        aggregateType: "recon_break",
        aggregateId: input.breakId,
        sequence: 1,
        eventType: "recon_break.resolution_proposed",
        payload: { breakCode: brk.break_code, resolutionType: input.resolutionType },
      },
      clock,
    );

    return { approvalId: approval.id };
  });
}

export async function approveBreakResolution(
  db: Kysely<Database>,
  breakId: string,
  checkerUserId: string,
  clock: Clock,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const brk = await trx.selectFrom("recon_break").selectAll().where("id", "=", breakId).executeTakeFirstOrThrow();
    if (brk.status !== "PENDING_APPROVAL") throw new BreakNotPendingError(breakId, brk.status);

    const approval = await trx
      .selectFrom("approval")
      .selectAll()
      .where("subject_type", "=", "recon_break")
      .where("subject_id", "=", breakId)
      .where("state", "=", "PENDING")
      .orderBy("maker_at", "desc")
      .executeTakeFirstOrThrow();

    if (approval.maker_user_id === checkerUserId) throw new SelfApprovalNotAllowedError();

    await trx
      .updateTable("approval")
      .set({ checker_user_id: checkerUserId, checker_at: clock.now(), state: "APPROVED" })
      .where("id", "=", approval.id)
      .execute();

    await trx
      .updateTable("recon_break")
      .set({ status: "RESOLVED", resolved_at: clock.now(), resolved_by_user_id: checkerUserId })
      .where("id", "=", breakId)
      .execute();

    await appendAuditEntry(
      trx,
      {
        actorType: "USER",
        actorId: checkerUserId,
        action: "recon_break.resolution_approved",
        entityType: "recon_break",
        entityId: breakId,
        beforeJson: { status: "PENDING_APPROVAL" },
        afterJson: { status: "RESOLVED", resolutionType: brk.resolution_type, makerUserId: approval.maker_user_id },
      },
      clock,
    );
    await appendOutboxEvent(
      trx,
      {
        aggregateType: "recon_break",
        aggregateId: breakId,
        sequence: 2,
        eventType: "recon_break.resolved",
        payload: { breakCode: brk.break_code, resolutionType: brk.resolution_type },
      },
      clock,
    );
  });
}

export async function rejectBreakResolution(
  db: Kysely<Database>,
  breakId: string,
  checkerUserId: string,
  comment: string,
  clock: Clock,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const brk = await trx.selectFrom("recon_break").selectAll().where("id", "=", breakId).executeTakeFirstOrThrow();
    if (brk.status !== "PENDING_APPROVAL") throw new BreakNotPendingError(breakId, brk.status);

    const approval = await trx
      .selectFrom("approval")
      .selectAll()
      .where("subject_type", "=", "recon_break")
      .where("subject_id", "=", breakId)
      .where("state", "=", "PENDING")
      .orderBy("maker_at", "desc")
      .executeTakeFirstOrThrow();

    if (approval.maker_user_id === checkerUserId) throw new SelfApprovalNotAllowedError();

    await trx
      .updateTable("approval")
      .set({ checker_user_id: checkerUserId, checker_at: clock.now(), state: "REJECTED", comment })
      .where("id", "=", approval.id)
      .execute();

    // Back to the analyst, with the proposed resolution cleared — a rejected
    // proposal must not leave a resolution_type sitting on an open break.
    await trx
      .updateTable("recon_break")
      .set({ status: "OPEN", resolution_type: null, approval_id: null })
      .where("id", "=", breakId)
      .execute();

    await appendAuditEntry(
      trx,
      {
        actorType: "USER",
        actorId: checkerUserId,
        action: "recon_break.resolution_rejected",
        entityType: "recon_break",
        entityId: breakId,
        beforeJson: { status: "PENDING_APPROVAL", resolutionType: brk.resolution_type },
        afterJson: { status: "OPEN", comment },
      },
      clock,
    );
  });
}

export interface BreakListRow {
  id: string;
  break_code: string;
  severity: string;
  amount_minor: bigint;
  business_date: string;
  status: string;
  resolution_type: string | null;
  narrative_raw: string | null;
  agency_code: string | null;
  payment_reference: string | null;
  maker_user_name: string | null;
  proposed_resolution: string | null;
  proposed_narrative: string | null;
}

/**
 * The persisted break register. Until now the only way to see breaks was to
 * re-run reconciliation and read the response, which meant the register could
 * not show the *state* of a break at all — only that it had been found.
 */
export async function listBreaks(
  db: Kysely<Database>,
  filters: { businessDate?: string; status?: string },
): Promise<BreakListRow[]> {
  let q = db
    .selectFrom("recon_break")
    .leftJoin("agency", "agency.id", "recon_break.agency_id")
    .leftJoin("payment", "payment.id", "recon_break.payment_id")
    .leftJoin("approval", (join) =>
      join
        .onRef("approval.subject_id", "=", "recon_break.id")
        .on("approval.subject_type", "=", "recon_break")
        .on("approval.state", "=", "PENDING"),
    )
    .leftJoin("platform_user", "platform_user.id", "approval.maker_user_id")
    .select([
      "recon_break.id",
      "recon_break.break_code",
      "recon_break.severity",
      "recon_break.amount_minor",
      "recon_break.business_date",
      "recon_break.status",
      "recon_break.resolution_type",
      "recon_break.narrative_raw",
      "agency.code as agency_code",
      "payment.payment_reference",
      "platform_user.name as maker_user_name",
      "approval.action as proposed_action",
      "approval.payload as proposed_payload",
    ])
    .orderBy("recon_break.severity", "asc")
    .orderBy("recon_break.break_code", "asc");

  if (filters.businessDate) q = q.where("recon_break.business_date", "=", filters.businessDate);
  if (filters.status) q = q.where("recon_break.status", "=", filters.status);

  const rows = await q.execute();
  return rows.map((r) => {
    const payload = r.proposed_payload as { resolutionType?: string; narrative?: string } | null;
    return {
      id: r.id,
      break_code: r.break_code,
      severity: r.severity,
      amount_minor: r.amount_minor,
      business_date: r.business_date,
      status: r.status,
      resolution_type: r.resolution_type,
      narrative_raw: r.narrative_raw,
      agency_code: r.agency_code,
      payment_reference: r.payment_reference,
      maker_user_name: r.maker_user_name,
      proposed_resolution: payload?.resolutionType ?? null,
      proposed_narrative: payload?.narrative ?? null,
    };
  });
}
