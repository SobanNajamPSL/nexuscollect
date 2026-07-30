import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { rfEncode } from "../../platform/checksum/rf.js";
import { toWireMinor } from "../../platform/money/index.js";

/** Shared GET/PATCH/cancel response shape, matching openapi.yaml's `Assessment`
 * schema (finding L). `payments` stays an empty array — Phase 2's payment
 * capture doesn't exist yet, so there's nothing real to put there; the field
 * is exposed per the contract rather than omitted. */
export async function mapAssessmentToApi(db: Kysely<Database>, assessmentId: string): Promise<Record<string, unknown>> {
  const row = await db
    .selectFrom("assessment")
    .innerJoin("agency", "agency.id", "assessment.agency_id")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .innerJoin("reference_scheme", "reference_scheme.id", "collection_product.reference_scheme_id")
    .select([
      "assessment.id",
      "assessment.psid",
      "assessment.external_ref",
      "assessment.description",
      "assessment.payer_snapshot",
      "assessment.currency",
      "assessment.assessed_amount_minor",
      "assessment.surcharge_accrued_minor",
      "assessment.discount_applied_minor",
      "assessment.payable_amount_minor",
      "assessment.allocated_amount_minor",
      "assessment.balance_minor",
      "assessment.issue_date",
      "assessment.due_date",
      "assessment.expiry_date",
      "assessment.status",
      "assessment.version",
      "assessment.service_gate_released_at",
      "assessment.metadata",
      "assessment.created_at",
      "agency.code as agency_code",
      "collection_product.code as product_code",
      "reference_scheme.total_length as reference_scheme_total_length",
    ])
    .where("assessment.id", "=", assessmentId)
    .executeTakeFirstOrThrow();

  const lineItems = await db
    .selectFrom("assessment_line_item")
    .innerJoin("revenue_head", "revenue_head.id", "assessment_line_item.revenue_head_id")
    .select([
      "assessment_line_item.seq",
      "assessment_line_item.line_type",
      "revenue_head.code as revenue_head_code",
      "assessment_line_item.tax_period",
      "assessment_line_item.description",
      "assessment_line_item.amount_minor",
      "assessment_line_item.allocated_minor",
      "assessment_line_item.allocation_priority",
    ])
    .where("assessment_id", "=", assessmentId)
    .orderBy("seq", "asc")
    .execute();

  const payerName = (row.payer_snapshot as Record<string, unknown> | null)?.["name"] as string | undefined;

  return {
    psid: row.psid,
    rf_reference: row.reference_scheme_total_length === 17 ? rfEncode(row.psid) : null,
    agency_code: row.agency_code,
    product_code: row.product_code,
    external_ref: row.external_ref,
    description: row.description,
    payer_name_snapshot: payerName ?? null,
    currency: row.currency,
    assessed_amount_minor: toWireMinor(row.assessed_amount_minor),
    surcharge_accrued_minor: toWireMinor(row.surcharge_accrued_minor),
    discount_applied_minor: toWireMinor(row.discount_applied_minor),
    payable_amount_minor: toWireMinor(row.payable_amount_minor),
    allocated_amount_minor: toWireMinor(row.allocated_amount_minor),
    balance_minor: toWireMinor(row.balance_minor),
    issue_date: row.issue_date,
    due_date: row.due_date,
    expiry_date: row.expiry_date,
    status: row.status,
    version: row.version,
    supersedes_psid_version: row.version > 1 ? row.version - 1 : null,
    service_gate_open: row.service_gate_released_at !== null,
    line_items: lineItems.map((l) => ({
      seq: l.seq,
      line_type: l.line_type,
      revenue_head_code: l.revenue_head_code,
      tax_period: l.tax_period,
      description: l.description,
      amount_minor: toWireMinor(l.amount_minor),
      allocated_minor: toWireMinor(l.allocated_minor),
      balance_minor: toWireMinor(l.amount_minor - l.allocated_minor),
      allocation_priority: l.allocation_priority,
    })),
    payments: [],
    metadata: row.metadata,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** Current (latest, non-superseded) version for a PSID. */
export async function findCurrentAssessmentIdByPsid(db: Kysely<Database>, psid: string): Promise<string | null> {
  const row = await db
    .selectFrom("assessment")
    .select("id")
    .where("psid", "=", psid)
    .where("status", "!=", "AMENDED")
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}
