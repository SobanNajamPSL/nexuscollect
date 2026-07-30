import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { dammValidate, luhnValidate, mod11Validate, mod9710Validate } from "../../platform/checksum/index.js";
import { rfValidate, rfEncode } from "../../platform/checksum/rf.js";
import { formatMinor, serializeMinor } from "../../platform/money/index.js";
import { mintResolutionToken } from "../../platform/resolution-token/index.js";
import { computeDerived, type EarlyDiscountRule, type RoundingRule, type SurchargeRule } from "../obligation/compute-derived.js";
import { ensureReceiptForSettledAssessment } from "../evidence/receipt.js";
import { maskPayerName } from "./mask.js";
import { findSchemeForKeyValue } from "./scheme-cache.js";
import { hashPrimaryId } from "../identity/pii.js";

/** §7.5's 11 documented key types (real cardinality/privacy rules exist for these). */
const DOCUMENTED_KEY_TYPES = [
  "PSID", "CRN", "RF_REFERENCE", "VEHICLE_REG", "CNIC", "NTN", "STRN",
  "CASE_NO", "APPLICATION_NO", "QR_PAYLOAD", "RAAST_ID",
] as const;
type DocumentedKeyType = (typeof DOCUMENTED_KEY_TYPES)[number];

/** §7.5-documented types resolved via resolution_index (not identity, not QR). */
const INDEX_KEY_TYPES = ["PSID", "RF_REFERENCE", "CRN", "VEHICLE_REG", "CASE_NO", "APPLICATION_NO"] as const;
/** §20.6: identity-keyed types requiring step-up before any detail is returned. */
const STEP_UP_KEY_TYPES = ["CNIC", "RAAST_ID"] as const;
/** §7.5: resolves via payer.primary_id_hash, not resolution_index. */
const IDENTITY_KEY_TYPES = ["CNIC", "NTN", "STRN"] as const;
/** §7.5: masked payer name for these key types (vs. full detail for PSID/CRN/RF_REFERENCE/QR_PAYLOAD). */
const MASKED_KEY_TYPES = ["VEHICLE_REG", "CASE_NO", "APPLICATION_NO"] as const;

const OPEN_STATUSES = ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] as const;

export interface IdentityAssertion {
  assertedByInstitution?: boolean | undefined;
  stepUpToken?: string | undefined;
}

export interface ResolveInput {
  keyType: string;
  keyValue: string;
  channel: string;
  identityAssertion?: IdentityAssertion | undefined;
}

export interface HeadBreakdownDTO {
  revenue_head_code: string;
  line_type: string;
  tax_period: string | null;
  amount_minor: string;
  balance_minor: string;
}

export interface PayableDTO {
  psid: string;
  rf_reference: string | null;
  agency_code: string;
  agency_name: string;
  product_code: string;
  category: string;
  label: string;
  payable_amount_minor: string;
  min_payable_minor: string;
  max_payable_minor: string;
  surcharge_accrued_minor: string;
  discount_applied_minor: string;
  discount_expires_on: string | null;
  amount_valid_until: string | null;
  currency: string;
  due_date: string;
  expires_at: string | null;
  status: string;
  partial_allowed: boolean;
  overpayment_allowed: boolean;
  fee_amount_minor: string;
  tax_on_fee_minor: string;
  fee_bearer: string;
  payer_name_masked: string | null;
  service_gating: string;
  head_breakdown: HeadBreakdownDTO[];
}

export interface SettledDTO {
  psid: string;
  status: string;
  settled_on: string;
  receipt_no: string;
  code: "ALREADY_SETTLED";
}

export type ResolveOutcome =
  | { kind: "INVALID_CHECKSUM" }
  | { kind: "AUTHENTICATION_REQUIRED" }
  | { kind: "NOT_CONFIGURED" }
  | {
      kind: "OK";
      payables: PayableDTO[];
      settled: SettledDTO[];
      resolutionToken: string | null;
      tokenExpiresAt: Date | null;
    };

function isDocumentedKeyType(keyType: string): keyType is DocumentedKeyType {
  return (DOCUMENTED_KEY_TYPES as readonly string[]).includes(keyType);
}

/**
 * §8.2 step 2: offline validation, before any DB hit. Only PSID and
 * RF_REFERENCE carry a documented check-digit scheme (§7.5) — the other key
 * types are agency-defined free text with no checksum to fail.
 */
function validateOffline(keyType: string, keyValue: string): boolean {
  if (keyType === "RF_REFERENCE") return rfValidate(keyValue);
  if (keyType === "PSID") {
    const scheme = findSchemeForKeyValue(keyValue);
    if (!scheme) return false;
    switch (scheme.checksumAlgo) {
      case "DAMM":
        return dammValidate(keyValue);
      case "LUHN":
        return luhnValidate(keyValue);
      case "MOD_97_10":
        return mod9710Validate(keyValue);
      case "MOD_11":
        return mod11Validate(keyValue);
      case "NONE":
        return true;
    }
  }
  return true;
}

function hasStepUp(assertion: IdentityAssertion | undefined): boolean {
  return Boolean(assertion?.assertedByInstitution) || Boolean(assertion?.stepUpToken);
}

interface CandidateAssessmentRow {
  id: string;
  psid: string;
  status: string;
  description: string;
  currency: string;
  assessed_amount_minor: bigint;
  due_date: string;
  issue_date: string;
  expiry_date: string | null;
  metadata: Record<string, unknown>;
  agency_code: string;
  agency_name: string;
  product_code: string;
  category: string;
  allow_partial: boolean;
  overpayment_allowed: boolean;
  fee_bearer: string;
  service_gating: string;
  surcharge_rule: SurchargeRule | null;
  early_discount_rule: EarlyDiscountRule | null;
  rounding_rule: RoundingRule | null;
  reference_scheme_total_length: number;
  payer_name_snapshot: string | null;
}

async function loadCandidateAssessments(db: Kysely<Database>, assessmentIds: readonly string[]): Promise<CandidateAssessmentRow[]> {
  if (assessmentIds.length === 0) return [];
  const rows = await db
    .selectFrom("assessment")
    .innerJoin("agency", "agency.id", "assessment.agency_id")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .innerJoin("reference_scheme", "reference_scheme.id", "collection_product.reference_scheme_id")
    .select([
      "assessment.id",
      "assessment.psid",
      "assessment.status",
      "assessment.description",
      "assessment.currency",
      "assessment.assessed_amount_minor",
      "assessment.due_date",
      "assessment.issue_date",
      "assessment.expiry_date",
      "assessment.metadata",
      "assessment.payer_snapshot",
      "agency.code as agency_code",
      "agency.name as agency_name",
      "collection_product.code as product_code",
      "collection_product.category",
      "collection_product.allow_partial",
      "collection_product.allow_overpayment as overpayment_allowed",
      "collection_product.fee_bearer",
      "collection_product.service_gating",
      "collection_product.surcharge_rule",
      "collection_product.early_discount_rule",
      "collection_product.rounding_rule",
      "reference_scheme.total_length as reference_scheme_total_length",
    ])
    .where("assessment.id", "in", assessmentIds as string[])
    .execute();

  return rows.map((r) => ({
    id: r.id,
    psid: r.psid,
    status: r.status,
    description: r.description,
    currency: r.currency,
    assessed_amount_minor: r.assessed_amount_minor,
    due_date: r.due_date,
    issue_date: r.issue_date,
    expiry_date: r.expiry_date,
    metadata: r.metadata as Record<string, unknown>,
    agency_code: r.agency_code,
    agency_name: r.agency_name,
    product_code: r.product_code,
    category: r.category,
    allow_partial: r.allow_partial,
    overpayment_allowed: r.overpayment_allowed,
    fee_bearer: r.fee_bearer,
    service_gating: r.service_gating,
    surcharge_rule: r.surcharge_rule as SurchargeRule | null,
    early_discount_rule: r.early_discount_rule as EarlyDiscountRule | null,
    rounding_rule: r.rounding_rule as RoundingRule | null,
    reference_scheme_total_length: r.reference_scheme_total_length,
    payer_name_snapshot: (r.payer_snapshot as Record<string, unknown> | null)?.["name"] as string | null ?? null,
  }));
}

async function loadLineItems(db: Kysely<Database>, assessmentIds: readonly string[]) {
  if (assessmentIds.length === 0) return new Map<string, { code: string; line_type: string; tax_period: string | null; amount_minor: bigint; allocated_minor: bigint }[]>();
  const rows = await db
    .selectFrom("assessment_line_item")
    .innerJoin("revenue_head", "revenue_head.id", "assessment_line_item.revenue_head_id")
    .select([
      "assessment_line_item.assessment_id",
      "revenue_head.code",
      "assessment_line_item.line_type",
      "assessment_line_item.tax_period",
      "assessment_line_item.amount_minor",
      "assessment_line_item.allocated_minor",
    ])
    .where("assessment_line_item.assessment_id", "in", assessmentIds as string[])
    .orderBy("assessment_line_item.seq", "asc")
    .execute();

  const byAssessment = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byAssessment.get(row.assessment_id) ?? [];
    list.push(row);
    byAssessment.set(row.assessment_id, list);
  }
  return byAssessment;
}

function buildPayable(
  row: CandidateAssessmentRow,
  lines: { code: string; line_type: string; tax_period: string | null; amount_minor: bigint; allocated_minor: bigint }[],
  asOfDate: string,
  maskName: boolean,
): PayableDTO {
  const principalMinor = lines.filter((l) => l.line_type === "PRINCIPAL").reduce((s, l) => s + l.amount_minor, 0n);
  const otherLinesMinor = lines.filter((l) => l.line_type !== "PRINCIPAL").reduce((s, l) => s + l.amount_minor, 0n);

  const derived = computeDerived({
    principalMinor,
    otherLinesMinor,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    asOfDate,
    surchargeRule: row.surcharge_rule,
    earlyDiscountRule: row.early_discount_rule,
    roundingRule: row.rounding_rule,
  });

  const rfReference = row.reference_scheme_total_length === 17 ? rfEncode(row.psid) : null;

  return {
    psid: row.psid,
    rf_reference: rfReference,
    agency_code: row.agency_code,
    agency_name: row.agency_name,
    product_code: row.product_code,
    category: row.category,
    label: row.description,
    payable_amount_minor: serializeMinor(derived.payableAmountMinor),
    min_payable_minor: serializeMinor(row.allow_partial ? 0n : derived.payableAmountMinor),
    max_payable_minor: serializeMinor(derived.payableAmountMinor),
    surcharge_accrued_minor: serializeMinor(derived.surchargeAccruedMinor),
    discount_applied_minor: serializeMinor(derived.discountAppliedMinor),
    discount_expires_on: derived.discountExpiresOn,
    amount_valid_until: derived.amountValidUntil,
    currency: row.currency,
    due_date: row.due_date,
    expires_at: row.expiry_date ? `${row.expiry_date}T23:59:59Z` : null,
    status: row.status,
    partial_allowed: row.allow_partial,
    overpayment_allowed: row.overpayment_allowed,
    fee_amount_minor: serializeMinor(0n), // no fee_schedule module yet (out of Phase 1 scope)
    tax_on_fee_minor: serializeMinor(0n),
    fee_bearer: row.fee_bearer,
    payer_name_masked: row.payer_name_snapshot ? maskPayerName(row.payer_name_snapshot) : null,
    service_gating: row.service_gating,
    head_breakdown: lines.map((l) => ({
      revenue_head_code: l.code,
      line_type: l.line_type,
      tax_period: l.tax_period,
      amount_minor: serializeMinor(l.amount_minor),
      balance_minor: serializeMinor(l.amount_minor - l.allocated_minor),
    })),
  };
}

/**
 * §8.2's 8-step resolve pipeline (steps 3 "rate/abuse check" is out of scope
 * for Phase 1 — no fraud/velocity module exists yet, and no gate test needs
 * it). Money never touches a float anywhere in this path.
 */
export async function resolveReference(db: Kysely<Database>, input: ResolveInput, clock: Clock): Promise<ResolveOutcome> {
  // Step 2: offline validation — zero DB queries below this line if it fails.
  if (!validateOffline(input.keyType, input.keyValue)) {
    return { kind: "INVALID_CHECKSUM" };
  }

  if (!isDocumentedKeyType(input.keyType)) {
    // The 6 undocumented ResolutionKeyType enum values (GD_NO, PROPERTY_ID,
    // INSTRUMENT_NO, TENDER_REF, CHASSIS_NO, DL_NO) — accepted at the schema
    // level to match openapi.yaml, but §7.5 gives them no cardinality or
    // privacy rule to implement against. See §27 open questions.
    return { kind: "NOT_CONFIGURED" };
  }
  if (input.keyType === "QR_PAYLOAD") {
    // EMVCo QR decode/encode is §8.5 / Phase 3 — not built yet.
    return { kind: "NOT_CONFIGURED" };
  }

  // Step: step-up gate for identity-keyed lookups (§20.6), before any DB hit.
  if ((STEP_UP_KEY_TYPES as readonly string[]).includes(input.keyType) && !hasStepUp(input.identityAssertion)) {
    return { kind: "AUTHENTICATION_REQUIRED" };
  }

  // Step 4: index lookup.
  let assessmentIds: string[];
  if ((IDENTITY_KEY_TYPES as readonly string[]).includes(input.keyType)) {
    const hash = hashPrimaryId(input.keyType, input.keyValue);
    const payer = await db.selectFrom("payer").select("id").where("primary_id_hash", "=", hash).executeTakeFirst();
    assessmentIds = payer
      ? (await db.selectFrom("assessment").select("id").where("payer_id", "=", payer.id).execute()).map((r) => r.id)
      : [];
  } else if ((INDEX_KEY_TYPES as readonly string[]).includes(input.keyType)) {
    const normalized = input.keyValue.trim().toUpperCase();
    const rows = await db
      .selectFrom("resolution_index")
      .select("assessment_id")
      .where("key_type", "=", input.keyType)
      .where("key_value_norm", "=", normalized)
      .where("is_open", "=", true)
      .execute();
    assessmentIds = rows.map((r) => r.assessment_id);
  } else {
    assessmentIds = [];
  }

  if (assessmentIds.length === 0) {
    return { kind: "OK", payables: [], settled: [], resolutionToken: null, tokenExpiresAt: null };
  }

  const candidates = await loadCandidateAssessments(db, assessmentIds);
  const lineItemsByAssessment = await loadLineItems(db, assessmentIds);
  const maskName = (MASKED_KEY_TYPES as readonly string[]).includes(input.keyType);
  const asOfDate = clock.now().toISOString().slice(0, 10);

  const openRows = candidates.filter((c) => (OPEN_STATUSES as readonly string[]).includes(c.status));
  const settledRows = candidates.filter((c) => c.status === "SETTLED");

  // Step 5/6/7: recompute derived amounts, filter, shape.
  const payables = openRows.map((row) => buildPayable(row, lineItemsByAssessment.get(row.id) ?? [], asOfDate, maskName));

  const settled: SettledDTO[] = [];
  for (const row of settledRows) {
    const receipt = await ensureReceiptForSettledAssessment(db, row.id, clock);
    if (!receipt) continue; // no applied allocation found — don't claim a receipt that doesn't exist
    settled.push({
      psid: row.psid,
      status: row.status,
      settled_on: receipt.businessDate,
      receipt_no: receipt.receiptNo,
      code: "ALREADY_SETTLED",
    });
  }

  // Step 8: resolution_token binds this exact amount set to this exact payable set.
  let resolutionToken: string | null = null;
  let tokenExpiresAt: Date | null = null;
  if (payables.length > 0) {
    const minted = await mintResolutionToken(
      { payables: payables.map((p) => ({ psid: p.psid, amountMinor: p.payable_amount_minor })) },
      clock,
    );
    resolutionToken = minted.token;
    tokenExpiresAt = minted.expiresAt;
  }

  return { kind: "OK", payables, settled, resolutionToken, tokenExpiresAt };
}

export { formatMinor };
