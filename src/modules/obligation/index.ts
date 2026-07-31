import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";
import { createRefundForAmendment } from "../refund/index.js";

/**
 * §9.1's assessment state machine, plus findings D/F/G from the audit:
 * every create/amend/cancel goes through `transition()`, which validates the
 * move, performs it, and appends a hash-chained audit row and a transactional
 * outbox event — all inside the ONE transaction the caller already opened, so
 * a rollback can never leave a dangling audit/outbox row and an illegal move
 * never reaches the database. "No status field may be assigned by direct
 * UPDATE" outside this function.
 */

type AssessmentStatus =
  | "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "SETTLED" | "OVERDUE" | "EXPIRED"
  | "CANCELLED" | "AMENDED" | "WRITTEN_OFF" | "CLOSED";

type TransitionEvent = "assessment.created" | "assessment.amended" | "assessment.cancelled";

const ALLOWED_TRANSITIONS: Record<TransitionEvent, readonly AssessmentStatus[]> = {
  "assessment.created": [], // from === null: no prior state to validate
  // §9.1: amendment is legal from any still-open state; the old version always becomes AMENDED.
  // SETTLED is included deliberately — §9.1's own rule table says "Amending
  // downward below what has already been paid triggers an automatic
  // overpayment (§14.2)", which is only reachable from a fully-paid
  // (SETTLED) assessment. Excluding it here was a real Phase 1 gap: §14.2's
  // entire scenario was unreachable through this guard until now.
  "assessment.amended": ["DRAFT", "ISSUED", "PARTIALLY_PAID", "OVERDUE", "SETTLED"],
  // §9.1: "Only from DRAFT, ISSUED, OVERDUE, EXPIRED with allocated = 0."
  "assessment.cancelled": ["DRAFT", "ISSUED", "OVERDUE", "EXPIRED"],
};

export class IllegalStateTransition extends Error {
  readonly httpStatus = 409;
  readonly code = "ILLEGAL_STATE_TRANSITION";
  constructor(event: TransitionEvent, from: string) {
    super(`Illegal transition: cannot apply "${event}" to an assessment in status ${from}`);
    this.name = "IllegalStateTransition";
  }
}

export class CannotCancelPaidAssessment extends Error {
  readonly httpStatus = 409;
  readonly code = "CANNOT_CANCEL_PAID_ASSESSMENT";
  constructor(assessmentId: string, allocatedMinor: bigint) {
    super(`Cannot cancel assessment ${assessmentId}: ${allocatedMinor} minor units already allocated — issue a refund instead`);
    this.name = "CannotCancelPaidAssessment";
  }
}

/** openapi.yaml's `VERSION_CONFLICT` (§9): the row was not in the exact
 * status+version the caller expected when the guarded UPDATE ran — either a
 * genuine optimistic-lock mismatch (amend) or a concurrent transition raced
 * ahead of us (cancel). Never a corrupted row: the guard means one of the two
 * concurrent writers gets this error and zero rows change underneath it. */
export class VersionConflictError extends Error {
  readonly httpStatus = 409;
  readonly code = "VERSION_CONFLICT";
  constructor(assessmentId: string, expectedVersion?: number) {
    super(
      `Assessment ${assessmentId} was not in the expected state` +
        (expectedVersion !== undefined ? ` (expected version ${expectedVersion})` : "") +
        " — concurrent modification detected",
    );
    this.name = "VersionConflictError";
  }
}

export class LineItemsOrphanAllocationError extends Error {
  readonly httpStatus = 422;
  readonly code = "LINE_ITEMS_DO_NOT_SUM";
  constructor(lineType: string, revenueHeadCode: string) {
    super(
      `Amendment's line_items omit ${lineType}/${revenueHeadCode}, which has real applied money against it — ` +
        "an amendment cannot orphan an existing allocation. Include this line (possibly at a new amount) or leave line_items unset to carry all lines forward unchanged.",
    );
    this.name = "LineItemsOrphanAllocationError";
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

interface TransitionInput {
  entityId: string;
  from: AssessmentStatus | null;
  to: AssessmentStatus;
  /** Required only for the optimistic-lock case (amend); adds `AND version = expectedVersion` to the guard. */
  expectedVersion?: number;
  event: TransitionEvent;
  actor: Actor;
  beforeJson: unknown;
  afterJson: unknown;
  eventPayload: unknown;
  correlationId?: string;
}

/** §9's own instruction, literally: `transition(entity, from, to, event, actor)`. */
async function transition(trx: Transaction<Database>, input: TransitionInput, clock: Clock): Promise<void> {
  if (input.from !== null) {
    if (!ALLOWED_TRANSITIONS[input.event].includes(input.from)) {
      throw new IllegalStateTransition(input.event, input.from);
    }

    let query = trx
      .updateTable("assessment")
      .set({ status: input.to, updated_at: clock.now() })
      .where("id", "=", input.entityId)
      .where("status", "=", input.from);
    if (input.expectedVersion !== undefined) {
      query = query.where("version", "=", input.expectedVersion);
    }
    const result = await query.executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0n) !== 1) {
      throw new VersionConflictError(input.entityId, input.expectedVersion);
    }
  }

  const sequence = await nextOutboxSequence(trx, "assessment", input.entityId);
  await appendAuditEntry(
    trx,
    {
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      action: input.event,
      entityType: "assessment",
      entityId: input.entityId,
      beforeJson: input.beforeJson,
      afterJson: input.afterJson,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    },
    clock,
  );
  await appendOutboxEvent(
    trx,
    {
      aggregateType: "assessment",
      aggregateId: input.entityId,
      sequence,
      eventType: input.event,
      payload: input.eventPayload,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    },
    clock,
  );
}

export interface LineItemInput {
  seq: number;
  lineType: "PRINCIPAL" | "SURCHARGE" | "PENALTY" | "INTEREST" | "FEE" | "TAX_ON_FEE" | "ROUNDING" | "ARREAR";
  revenueHeadCode: string;
  taxPeriod?: string | null;
  description?: string | null;
  amountMinor: bigint;
  allocationPriority?: number;
}

export interface CreateAssessmentInput {
  psid: string;
  agencyId: string;
  productId: string;
  payerId?: string;
  payerAccountId?: string;
  payerSnapshot: Record<string, unknown>;
  externalRef?: string;
  description: string;
  currency?: string;
  assessedAmountMinor: bigint;
  lineItems: readonly LineItemInput[];
  issueDate: string;
  dueDate: string;
  expiryDate?: string;
  source: string;
  metadata?: Record<string, unknown>;
}

async function resolveRevenueHeadIds(trx: Transaction<Database>, agencyId: string, codes: readonly string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await trx
    .selectFrom("revenue_head")
    .select(["id", "code"])
    .where("agency_id", "=", agencyId)
    .where("code", "in", [...new Set(codes)])
    .execute();
  return new Map(rows.map((r) => [r.code, r.id]));
}

export async function createAssessment(
  db: Kysely<Database>,
  input: CreateAssessmentInput,
  actor: Actor,
  clock: Clock,
): Promise<{ id: string }> {
  return db.transaction().execute(async (trx) => {
    const revenueHeadIds = await resolveRevenueHeadIds(trx, input.agencyId, input.lineItems.map((l) => l.revenueHeadCode));
    const newId = randomUUID();

    await trx
      .insertInto("assessment")
      .values({
        id: newId,
        psid: input.psid,
        agency_id: input.agencyId,
        product_id: input.productId,
        payer_id: input.payerId ?? null,
        payer_account_id: input.payerAccountId ?? null,
        payer_snapshot: JSON.stringify(input.payerSnapshot) as never,
        external_ref: input.externalRef ?? null,
        description: input.description,
        currency: input.currency ?? "PKR",
        assessed_amount_minor: input.assessedAmountMinor,
        discount_applied_minor: 0n,
        payable_amount_minor: input.assessedAmountMinor,
        allocated_amount_minor: 0n,
        balance_minor: input.assessedAmountMinor,
        issue_date: input.issueDate,
        due_date: input.dueDate,
        expiry_date: input.expiryDate ?? null,
        status: "ISSUED",
        source: input.source,
        version: 1,
        metadata: JSON.stringify(input.metadata ?? {}) as never,
      })
      .execute();

    for (const line of input.lineItems) {
      const revenueHeadId = revenueHeadIds.get(line.revenueHeadCode);
      if (!revenueHeadId) throw new Error(`Unknown revenue_head_code "${line.revenueHeadCode}" for agency ${input.agencyId}`);
      await trx
        .insertInto("assessment_line_item")
        .values({
          assessment_id: newId,
          seq: line.seq,
          line_type: line.lineType,
          revenue_head_id: revenueHeadId,
          tax_period: line.taxPeriod ?? null,
          description: line.description ?? null,
          amount_minor: line.amountMinor,
          allocation_priority: line.allocationPriority ?? 100,
        })
        .execute();
    }
    // Migration 0018's deferred constraint trigger checks
    // SUM(line.amount_minor) = assessment.assessed_amount_minor at COMMIT,
    // covering this insert path unconditionally (finding E).

    await transition(
      trx,
      {
        entityId: newId,
        from: null,
        to: "ISSUED",
        event: "assessment.created",
        actor,
        beforeJson: null,
        afterJson: { psid: input.psid, assessedAmountMinor: input.assessedAmountMinor.toString(), status: "ISSUED" },
        eventPayload: { assessmentId: newId, psid: input.psid, assessedAmountMinor: input.assessedAmountMinor.toString() },
      },
      clock,
    );

    return { id: newId };
  });
}

export interface AmendAssessmentInput {
  expectedVersion: number;
  reasonCode: "APPEAL_ALLOWED" | "RECTIFICATION_ORDER" | "CLERICAL_ERROR" | "REASSESSMENT" | "WAIVER_GRANTED" | "DISCOUNT_APPLIED";
  narrative?: string;
  description?: string;
  dueDate?: string;
  expiryDate?: string;
  /** Sum must equal the new assessed_amount_minor. Omit entirely to carry the
   * old version's line items forward unchanged (the common case — amending
   * dates/description/metadata only). Required whenever the amount changes:
   * there's no way to redistribute an amount delta across line types without
   * the agency saying explicitly where it goes (mirrors createAssessment's
   * own "line_items are mandatory" rule). */
  lineItems?: readonly LineItemInput[];
  metadata?: Record<string, unknown>;
}

export interface AmendAssessmentResult {
  newAssessmentId: string;
  version: number;
  balanceMinor: bigint;
  /** §14.2: amending below what's already been allocated recognises an
   * overpayment, routed per the product's `overpay_treatment` — `refundId`
   * is set for AUTO_REFUND, null for CREDIT_ON_ACCOUNT/ABSORB/REJECT (real
   * dispositions, not a missing feature). */
  overpaymentRecognisedMinor: bigint;
  refundId: string | null;
}

interface LoadedLineItem {
  id: string;
  line_type: string;
  revenue_head_id: string;
  tax_period: string | null;
  description: string | null;
  amount_minor: bigint;
  allocated_minor: bigint;
  allocation_priority: number;
}

/** §9.1: "Never mutate a paid assessment's amounts in place. Create version
 * v+1, keep the same PSID, mark v as AMENDED, carry allocations forward
 * AUTHORITATIVELY" (finding D — re-pointing the real payment_allocation rows,
 * not just copying a cached total). */
export async function amendAssessment(
  db: Kysely<Database>,
  assessmentId: string,
  changes: AmendAssessmentInput,
  actor: Actor,
  clock: Clock,
): Promise<AmendAssessmentResult> {
  return db.transaction().execute(async (trx: Transaction<Database>) => {
    const old = await trx.selectFrom("assessment").selectAll().where("id", "=", assessmentId).executeTakeFirstOrThrow();
    const oldLineItems = await trx
      .selectFrom("assessment_line_item")
      .select(["id", "line_type", "revenue_head_id", "tax_period", "description", "amount_minor", "allocated_minor", "allocation_priority"])
      .where("assessment_id", "=", assessmentId)
      .execute();

    const newId = randomUUID();

    interface ResolvedPlanLine {
      seq: number;
      lineType: LoadedLineItem["line_type"];
      revenueHeadId: string;
      taxPeriod: string | null;
      description: string | null;
      amountMinor: bigint;
      allocationPriority: number;
      oldMatch: LoadedLineItem | undefined;
    }

    let plan: ResolvedPlanLine[];
    let assessedAmountMinor: bigint;

    if (changes.lineItems) {
      const revenueHeadIds = await resolveRevenueHeadIds(trx, old.agency_id, changes.lineItems.map((l) => l.revenueHeadCode));
      plan = changes.lineItems.map((l) => {
        const revenueHeadId = revenueHeadIds.get(l.revenueHeadCode);
        if (!revenueHeadId) throw new Error(`Unknown revenue_head_code "${l.revenueHeadCode}" for agency ${old.agency_id}`);
        const taxPeriod = l.taxPeriod ?? null;
        return {
          seq: l.seq,
          lineType: l.lineType,
          revenueHeadId,
          taxPeriod,
          description: l.description ?? null,
          amountMinor: l.amountMinor,
          allocationPriority: l.allocationPriority ?? 100,
          oldMatch: oldLineItems.find((o) => o.line_type === l.lineType && o.revenue_head_id === revenueHeadId && o.tax_period === taxPeriod),
        };
      });
      assessedAmountMinor = plan.reduce((s, l) => s + l.amountMinor, 0n);

      // Any old line with real applied money must have a matching new line
      // (same line_type/revenue_head/tax_period) — an amendment can change
      // amounts, never orphan an existing allocation.
      for (const o of oldLineItems) {
        if (o.allocated_minor <= 0n) continue;
        const stillPresent = plan.some((n) => n.lineType === o.line_type && n.revenueHeadId === o.revenue_head_id && n.taxPeriod === o.tax_period);
        if (!stillPresent) throw new LineItemsOrphanAllocationError(o.line_type, o.revenue_head_id);
      }
    } else {
      assessedAmountMinor = old.assessed_amount_minor;
      plan = oldLineItems.map((o, i) => ({
        seq: i + 1,
        lineType: o.line_type as LoadedLineItem["line_type"],
        revenueHeadId: o.revenue_head_id,
        taxPeriod: o.tax_period,
        description: o.description,
        amountMinor: o.amount_minor,
        allocationPriority: o.allocation_priority,
        oldMatch: o,
      }));
    }

    // A reduced line can never carry forward MORE allocated_minor than its own
    // new amount (assessment_line_item's own CHECK constraint disallows a line
    // showing as "paid more than it's worth"). Re-point real payment_allocation
    // ROWS onto the new line greedily, up to its capacity — never splitting a
    // single row's amount, since that would fabricate a division of a real
    // transaction that never happened. Whatever rows don't fit simply stay
    // pointed at the OLD (now AMENDED, but still intact — nothing is deleted)
    // line item: that's real money with no room in the new version, which is
    // exactly the overpayment §14.2 describes, tracked explicitly rather than
    // silently dropped or forced into a value the DB would reject.
    const oldLineIdsWithMoney = oldLineItems.filter((o) => o.allocated_minor > 0n).map((o) => o.id);
    const allocationRows =
      oldLineIdsWithMoney.length > 0
        ? await trx
            .selectFrom("payment_allocation")
            .select(["id", "line_item_id", "amount_minor"])
            .where("line_item_id", "in", oldLineIdsWithMoney)
            .where("status", "=", "APPLIED")
            .orderBy("applied_at", "asc")
            .orderBy("id", "asc")
            .execute()
        : [];
    const rowsByOldLineId = new Map<string, { id: string; amount_minor: bigint }[]>();
    for (const row of allocationRows) {
      const list = rowsByOldLineId.get(row.line_item_id) ?? [];
      list.push({ id: row.id, amount_minor: row.amount_minor });
      rowsByOldLineId.set(row.line_item_id, list);
    }

    const resolvedLines = plan.map((p) => {
      const rows = p.oldMatch ? (rowsByOldLineId.get(p.oldMatch.id) ?? []) : [];
      let allocatedMinor = 0n;
      const takenRowIds: string[] = [];
      for (const row of rows) {
        if (allocatedMinor + row.amount_minor > p.amountMinor) break; // simple prefix greedy — never split a row
        allocatedMinor += row.amount_minor;
        takenRowIds.push(row.id);
      }
      const oldAllocated = p.oldMatch?.allocated_minor ?? 0n;
      return { ...p, allocatedMinor, excessMinor: oldAllocated - allocatedMinor, takenRowIds };
    });

    const payableAmountMinor = assessedAmountMinor - old.discount_applied_minor;
    const allocatedAmountMinor = resolvedLines.reduce((s, l) => s + l.allocatedMinor, 0n);
    const overpaymentFromLineReductions = resolvedLines.reduce((s, l) => s + l.excessMinor, 0n);
    const balanceMinor = payableAmountMinor - allocatedAmountMinor;
    const overpaymentRecognisedMinor = overpaymentFromLineReductions + (balanceMinor < 0n ? -balanceMinor : 0n);

    await trx
      .insertInto("assessment")
      .values({
        id: newId,
        psid: old.psid, // same PSID — this is the point of amendment vs. a new obligation
        agency_id: old.agency_id,
        product_id: old.product_id,
        payer_id: old.payer_id,
        payer_account_id: old.payer_account_id,
        payer_snapshot: JSON.stringify(old.payer_snapshot) as never,
        external_ref: old.external_ref,
        description: changes.description ?? old.description,
        currency: old.currency,
        assessed_amount_minor: assessedAmountMinor,
        surcharge_accrued_minor: old.surcharge_accrued_minor,
        discount_applied_minor: old.discount_applied_minor,
        payable_amount_minor: payableAmountMinor,
        allocated_amount_minor: allocatedAmountMinor,
        balance_minor: balanceMinor,
        issue_date: old.issue_date,
        due_date: changes.dueDate ?? old.due_date,
        expiry_date: changes.expiryDate ?? old.expiry_date,
        status: "ISSUED",
        source: old.source,
        version: old.version + 1,
        supersedes_id: old.id,
        metadata: JSON.stringify(changes.metadata ?? old.metadata) as never,
      })
      .execute();

    for (const line of resolvedLines) {
      const insertedLine = await trx
        .insertInto("assessment_line_item")
        .values({
          assessment_id: newId,
          seq: line.seq,
          line_type: line.lineType as never,
          revenue_head_id: line.revenueHeadId,
          tax_period: line.taxPeriod,
          description: line.description,
          amount_minor: line.amountMinor,
          allocated_minor: line.allocatedMinor,
          allocation_priority: line.allocationPriority,
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      // Re-point exactly the real payment_allocation ROWS this line absorbed
      // — authoritative, not a copied cached total (finding D). Rows left
      // behind (excessMinor > 0) stay correctly pointed at the old, now-
      // AMENDED-but-still-intact line item.
      if (line.takenRowIds.length > 0) {
        await trx
          .updateTable("payment_allocation")
          .set({ assessment_id: newId, line_item_id: insertedLine.id })
          .where("id", "in", line.takenRowIds)
          .execute();
      }
    }
    // Migration 0018's deferred constraint trigger checks the new version's
    // lines sum to assessed_amount_minor at COMMIT (finding E).

    await transition(
      trx,
      {
        entityId: old.id,
        from: old.status as AssessmentStatus,
        to: "AMENDED",
        expectedVersion: changes.expectedVersion,
        event: "assessment.amended",
        actor,
        beforeJson: { version: old.version, status: old.status, assessedAmountMinor: old.assessed_amount_minor.toString() },
        afterJson: {
          newAssessmentId: newId,
          version: old.version + 1,
          assessedAmountMinor: assessedAmountMinor.toString(),
          reasonCode: changes.reasonCode,
          narrative: changes.narrative ?? null,
        },
        eventPayload: {
          assessmentId: old.id,
          newAssessmentId: newId,
          psid: old.psid,
          version: old.version + 1,
          reasonCode: changes.reasonCode,
        },
      },
      clock,
    );

    // §14.2 step 5: route the surplus per the product's own overpay_treatment
    // — AUTO_REFUND raises a real refund (PENDING_APPROVAL); CREDIT_ON_ACCOUNT/
    // ABSORB/REJECT are different, legitimate dispositions of the same
    // surplus, not a refund, so no refund row is created for those.
    let refundId: string | null = null;
    if (overpaymentRecognisedMinor > 0n) {
      const product = await trx.selectFrom("collection_product").select("overpay_treatment").where("id", "=", old.product_id).executeTakeFirstOrThrow();
      refundId = await createRefundForAmendment(trx, { assessmentId: old.id, overpaymentRecognisedMinor, overpayTreatment: product.overpay_treatment, actorId: actor.actorId }, clock);
    }

    return {
      newAssessmentId: newId,
      version: old.version + 1,
      balanceMinor,
      overpaymentRecognisedMinor,
      refundId,
    };
  });
}

export interface CancelAssessmentInput {
  reasonCode: "ISSUED_IN_ERROR" | "DUPLICATE" | "WITHDRAWN" | "SUPERSEDED" | "COURT_ORDER";
  narrative?: string;
}

/** §9.1: "Only from DRAFT, ISSUED, OVERDUE, EXPIRED with allocated = 0. If any
 * money has been applied, the agency must issue a refund instead." */
export async function cancelAssessment(
  db: Kysely<Database>,
  assessmentId: string,
  input: CancelAssessmentInput,
  actor: Actor,
  clock: Clock,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const assessment = await trx.selectFrom("assessment").selectAll().where("id", "=", assessmentId).executeTakeFirstOrThrow();
    if (assessment.allocated_amount_minor > 0n) {
      throw new CannotCancelPaidAssessment(assessmentId, assessment.allocated_amount_minor);
    }

    await transition(
      trx,
      {
        entityId: assessmentId,
        from: assessment.status as AssessmentStatus,
        to: "CANCELLED",
        event: "assessment.cancelled",
        actor,
        beforeJson: { status: assessment.status },
        afterJson: { status: "CANCELLED", reasonCode: input.reasonCode, narrative: input.narrative ?? null },
        eventPayload: { assessmentId, psid: assessment.psid, reasonCode: input.reasonCode },
      },
      clock,
    );
  });
}

export interface RebuiltBalance {
  allocatedFromLineItems: bigint;
  allocatedFromPaymentAllocations: bigint;
  cachedAllocatedAmountMinor: bigint;
  balanceMinor: bigint;
  /** True iff every one of the three sources above agree exactly. */
  matches: boolean;
}

/** Finding D: proves rebuilding from allocations reproduces the cached values
 * byte-identically — never trusts the cache itself as the source of truth. */
export async function rebuildAssessmentBalance(db: Kysely<Database>, assessmentId: string): Promise<RebuiltBalance> {
  const assessment = await db.selectFrom("assessment").selectAll().where("id", "=", assessmentId).executeTakeFirstOrThrow();
  const lineItems = await db
    .selectFrom("assessment_line_item")
    .select(["amount_minor", "allocated_minor"])
    .where("assessment_id", "=", assessmentId)
    .execute();
  const allocatedFromLineItems = lineItems.reduce((s, l) => s + l.allocated_minor, 0n);

  const allocationRows = await db
    .selectFrom("payment_allocation")
    .select(["amount_minor"])
    .where("assessment_id", "=", assessmentId)
    .where("status", "=", "APPLIED")
    .execute();
  const allocatedFromPaymentAllocations = allocationRows.reduce((s, r) => s + r.amount_minor, 0n);

  const balanceMinor = assessment.payable_amount_minor - allocatedFromLineItems;
  const matches = allocatedFromLineItems === assessment.allocated_amount_minor && allocatedFromLineItems === allocatedFromPaymentAllocations;

  return { allocatedFromLineItems, allocatedFromPaymentAllocations, cachedAllocatedAmountMinor: assessment.allocated_amount_minor, balanceMinor, matches };
}
