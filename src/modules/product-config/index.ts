import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";

/**
 * §5/C1 "no-code onboarding": create a new collection product entirely
 * through configuration, no platform code change. Mirrors the maker-checker
 * pattern already established for refunds/breaks — an `AGENCY_OPERATOR`
 * proposes, an `AGENCY_ADMIN` approves, enforced via the same `approval`
 * table (never the same user twice).
 *
 * Note on amendment: unlike `assessment` (which is explicitly versioned —
 * §9.1), `collection_product` carries no version history in this schema.
 * `amendProduct` below is therefore a real, disclosed in-place update, not a
 * fabricated version chain — a new fiscal-year rule change would need a
 * schema addition this build doesn't have.
 */

export interface CreateProductInput {
  agencyId: string;
  code: string;
  name: string;
  category: "TAX" | "DUTY" | "FINE" | "PENALTY" | "FEE" | "BILL" | "STAMP" | "DEPOSIT" | "MISC";
  referenceSchemeId: string;
  amountRule: "FIXED" | "ASSESSED" | "OPEN" | "MIN_MAX";
  allowPartial: boolean;
  overpayTreatment: "REJECT" | "CREDIT_ON_ACCOUNT" | "AUTO_REFUND" | "ABSORB";
  allocationWaterfall: "OLDEST_FIRST" | "PENALTY_FIRST" | "PRINCIPAL_FIRST" | "PRO_RATA" | "EXPLICIT_ONLY";
  allowedChannels: string[];
  allowedInstruments: string[];
  instrumentCreditPolicy: "ON_CLEARING" | "PROVISIONAL_ON_LODGEMENT" | "PROVISIONAL_WITH_GATE_HOLD";
  feeBearer: "PAYER" | "AGENCY" | "SPLIT";
  defaultRevenueHeadId: string;
  serviceGating: "NONE" | "BLOCKS_SERVICE" | "RELEASES_GOODS";
  depositRefundable: boolean;
  effectiveFrom: string;
  actorId: string;
}

export async function createProduct(db: Kysely<Database>, input: CreateProductInput, clock: Clock): Promise<{ productId: string; status: string }> {
  return db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("collection_product")
      .values({
        agency_id: input.agencyId, code: input.code, name: input.name, category: input.category,
        reference_scheme_id: input.referenceSchemeId, amount_rule: input.amountRule,
        allow_partial: input.allowPartial, overpay_treatment: input.overpayTreatment,
        allocation_waterfall: input.allocationWaterfall, allowed_channels: input.allowedChannels,
        allowed_instruments: input.allowedInstruments, instrument_credit_policy: input.instrumentCreditPolicy,
        fee_bearer: input.feeBearer, default_revenue_head_id: input.defaultRevenueHeadId,
        service_gating: input.serviceGating, deposit_refundable: input.depositRefundable,
        status: "PENDING_APPROVAL", effective_from: input.effectiveFrom,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx.insertInto("approval").values({ subject_type: "collection_product", subject_id: inserted.id, action: "CREATE_PRODUCT", amount_minor: null, payload: JSON.stringify({ code: input.code, name: input.name }) as never, maker_user_id: input.actorId, state: "PENDING" }).execute();
    await appendAuditEntry(trx, { actorType: "USER", actorId: input.actorId, action: "product.created", entityType: "collection_product", entityId: inserted.id, afterJson: { code: input.code, status: "PENDING_APPROVAL" } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "collection_product", aggregateId: inserted.id, sequence: 1, eventType: "product.created", payload: { productId: inserted.id, code: input.code } }, clock);

    return { productId: inserted.id, status: "PENDING_APPROVAL" };
  });
}

export class SelfApprovalNotAllowedError extends Error {
  readonly httpStatus = 409;
  readonly code = "SELF_APPROVAL_NOT_ALLOWED";
  constructor() {
    super("The maker of a product cannot also approve it");
    this.name = "SelfApprovalNotAllowedError";
  }
}

export async function approveProduct(db: Kysely<Database>, productId: string, checkerUserId: string, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const approval = await trx.selectFrom("approval").selectAll().where("subject_type", "=", "collection_product").where("subject_id", "=", productId).where("state", "=", "PENDING").orderBy("maker_at", "desc").executeTakeFirstOrThrow();
    if (approval.maker_user_id === checkerUserId) throw new SelfApprovalNotAllowedError();

    await trx.updateTable("approval").set({ checker_user_id: checkerUserId, checker_at: clock.now(), state: "APPROVED" }).where("id", "=", approval.id).execute();
    await trx.updateTable("collection_product").set({ status: "ACTIVE" }).where("id", "=", productId).execute();
    await appendAuditEntry(trx, { actorType: "USER", actorId: checkerUserId, action: "product.approved", entityType: "collection_product", entityId: productId, beforeJson: { status: "PENDING_APPROVAL" }, afterJson: { status: "ACTIVE" } }, clock);
    await appendOutboxEvent(trx, { aggregateType: "collection_product", aggregateId: productId, sequence: 2, eventType: "product.approved", payload: { productId } }, clock);
  });
}

export interface AmendProductInput {
  allowPartial?: boolean;
  overpayTreatment?: "REJECT" | "CREDIT_ON_ACCOUNT" | "AUTO_REFUND" | "ABSORB";
  allocationWaterfall?: "OLDEST_FIRST" | "PENALTY_FIRST" | "PRINCIPAL_FIRST" | "PRO_RATA" | "EXPLICIT_ONLY";
  allowedChannels?: string[];
}

export async function amendProduct(db: Kysely<Database>, productId: string, patch: AmendProductInput, actorId: string, clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx.selectFrom("collection_product").selectAll().where("id", "=", productId).executeTakeFirstOrThrow();
    await trx
      .updateTable("collection_product")
      .set({
        ...(patch.allowPartial !== undefined ? { allow_partial: patch.allowPartial } : {}),
        ...(patch.overpayTreatment !== undefined ? { overpay_treatment: patch.overpayTreatment } : {}),
        ...(patch.allocationWaterfall !== undefined ? { allocation_waterfall: patch.allocationWaterfall } : {}),
        ...(patch.allowedChannels !== undefined ? { allowed_channels: patch.allowedChannels } : {}),
      })
      .where("id", "=", productId)
      .execute();
    await appendAuditEntry(trx, { actorType: "USER", actorId, action: "product.amended", entityType: "collection_product", entityId: productId, beforeJson: { allowPartial: before.allow_partial, overpayTreatment: before.overpay_treatment, allocationWaterfall: before.allocation_waterfall }, afterJson: patch }, clock);
    await appendOutboxEvent(trx, { aggregateType: "collection_product", aggregateId: productId, sequence: 3, eventType: "product.amended", payload: { productId, patch } }, clock);
  });
}
