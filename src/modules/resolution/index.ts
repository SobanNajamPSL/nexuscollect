import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { dammValidate, luhnValidate, mod11Validate, mod9710Validate } from "../../platform/checksum/index.js";
import { rfValidate, rfEncode } from "../../platform/checksum/rf.js";
import { formatMinor, toWireMinor } from "../../platform/money/index.js";
import { mintResolutionToken } from "../../platform/resolution-token/index.js";
import { computeDerived, type EarlyDiscountRule, type RoundingRule, type SurchargeRule } from "../obligation/compute-derived.js";
import { findReceiptForPayment } from "../evidence/receipt.js";
import { maskPayerName } from "./mask.js";
import { findSchemeForKeyValue } from "./scheme-cache.js";
import { hashPrimaryId } from "../identity/pii.js";
import { decodeQrPayload, QrDecodeError } from "./qr-decode.js";
import { normalizeKeyValue } from "./normalize.js";

/**
 * §7.5 documents cardinality/privacy rules in prose for 11 of the 17
 * `ResolutionKeyType` enum values from api/openapi.yaml. Finding C (audit):
 * this now implements real, fixture-backed resolution for ALL 17 — the
 * generic `resolution_index` lookup below covers 12 of them uniformly (PSID,
 * RF_REFERENCE, CRN, and every `secondary_lookup_keys` type any product
 * declares — VEHICLE_REG/CASE_NO/APPLICATION_NO plus the 6 previously
 * "undocumented" GD_NO/PROPERTY_ID/INSTRUMENT_NO/TENDER_REF/CHASSIS_NO/DL_NO —
 * with zero per-type branching, since the DB trigger already indexes
 * whatever each product configures). Only 3 types (CNIC/NTN/STRN) resolve via
 * a payer-wide identity lookup instead of a per-assessment index row, plus
 * RAAST_ID (its own payer field) and QR_PAYLOAD (decoded statelessly, then
 * re-resolved by the PSID it embeds).
 */
const IDENTITY_KEY_TYPES = ["CNIC", "NTN", "STRN"] as const;
const RAAST_KEY_TYPE = "RAAST_ID";
const QR_KEY_TYPE = "QR_PAYLOAD";
/** §20.6: only these two require step-up before any detail is returned. */
const STEP_UP_KEY_TYPES = ["CNIC", "RAAST_ID"] as const;
/** §7.5: full detail for PSID/CRN/RF_REFERENCE/QR_PAYLOAD; masked otherwise.
 * No privacy guidance exists in the spec for the 6 previously-undocumented
 * types, so they default to masked too — the conservative, privacy-preserving
 * choice when the spec is silent, not an invented rule. */
const FULL_DETAIL_KEY_TYPES = ["PSID", "CRN", "RF_REFERENCE", "QR_PAYLOAD"] as const;

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

/** finding M: `*_minor` fields are wire-serialised as a JSON integer of minor
 * units (api/openapi.yaml's `MinorAmount`: `{type: integer, format: int64}`)
 * — never a decimal, never a string. `bigint` stays the internal
 * representation throughout; `toWireMinor` converts only at this DTO
 * boundary, guarded to throw rather than silently truncate past
 * Number.MAX_SAFE_INTEGER (never happens in this dataset, but a real guard). */
export interface HeadBreakdownDTO {
  revenue_head_code: string;
  line_type: string;
  tax_period: string | null;
  amount_minor: number;
  balance_minor: number;
}

export interface PayableDTO {
  psid: string;
  rf_reference: string | null;
  agency_code: string;
  agency_name: string;
  product_code: string;
  category: string;
  label: string;
  payable_amount_minor: number;
  min_payable_minor: number;
  max_payable_minor: number;
  surcharge_accrued_minor: number;
  discount_applied_minor: number;
  discount_expires_on: string | null;
  amount_valid_until: string | null;
  currency: string;
  due_date: string;
  expires_at: string | null;
  status: string;
  partial_allowed: boolean;
  overpayment_allowed: boolean;
  fee_amount_minor: number;
  tax_on_fee_minor: number;
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
  | { kind: "QR_CRC_INVALID" }
  | { kind: "AGENCY_UNAVAILABLE" }
  | { kind: "CHANNEL_NOT_ELIGIBLE" }
  | {
      kind: "OK";
      payables: PayableDTO[];
      settled: SettledDTO[];
      resolutionToken: string | null;
      tokenExpiresAt: Date | null;
    };

/** §8.2 step 2: offline validation, before any DB hit. Only PSID and
 * RF_REFERENCE carry a documented check-digit scheme (§7.5). */
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
  due_date: string;
  issue_date: string;
  expiry_date: string | null;
  payer_name_snapshot: string | null;
  agency_code: string;
  agency_name: string;
  agency_status: string;
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
  product_status: string;
  product_effective_from: string;
  product_effective_to: string | null;
  allowed_channels: string[];
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
      "assessment.due_date",
      "assessment.issue_date",
      "assessment.expiry_date",
      "assessment.payer_snapshot",
      "agency.code as agency_code",
      "agency.name as agency_name",
      "agency.status as agency_status",
      "collection_product.code as product_code",
      "collection_product.category",
      "collection_product.allow_partial",
      "collection_product.allow_overpayment as overpayment_allowed",
      "collection_product.fee_bearer",
      "collection_product.service_gating",
      "collection_product.surcharge_rule",
      "collection_product.early_discount_rule",
      "collection_product.rounding_rule",
      "collection_product.status as product_status",
      "collection_product.effective_from as product_effective_from",
      "collection_product.effective_to as product_effective_to",
      "collection_product.allowed_channels",
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
    due_date: r.due_date,
    issue_date: r.issue_date,
    expiry_date: r.expiry_date,
    payer_name_snapshot: (r.payer_snapshot as Record<string, unknown> | null)?.["name"] as string | null ?? null,
    agency_code: r.agency_code,
    agency_name: r.agency_name,
    agency_status: r.agency_status,
    product_code: r.product_code,
    category: r.category,
    allow_partial: r.allow_partial,
    overpayment_allowed: r.overpayment_allowed,
    fee_bearer: r.fee_bearer,
    service_gating: r.service_gating,
    surcharge_rule: r.surcharge_rule as SurchargeRule | null,
    early_discount_rule: r.early_discount_rule as EarlyDiscountRule | null,
    rounding_rule: r.rounding_rule as RoundingRule | null,
    product_status: r.product_status,
    product_effective_from: r.product_effective_from,
    product_effective_to: r.product_effective_to,
    allowed_channels: r.allowed_channels,
    reference_scheme_total_length: r.reference_scheme_total_length,
  }));
}

interface LineItemRow {
  code: string;
  line_type: string;
  tax_period: string | null;
  amount_minor: bigint;
  allocated_minor: bigint;
}

async function loadLineItems(db: Kysely<Database>, assessmentIds: readonly string[]): Promise<Map<string, LineItemRow[]>> {
  if (assessmentIds.length === 0) return new Map();
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

  const byAssessment = new Map<string, LineItemRow[]>();
  for (const row of rows) {
    const list = byAssessment.get(row.assessment_id) ?? [];
    list.push({ code: row.code, line_type: row.line_type, tax_period: row.tax_period, amount_minor: row.amount_minor, allocated_minor: row.allocated_minor });
    byAssessment.set(row.assessment_id, list);
  }
  return byAssessment;
}

/** §14.2/finding A: the payable amount is the LIVE outstanding balance —
 * original assessed total (recomputed for surcharge/discount/rounding as of
 * today) minus what's authoritatively already been allocated, derived from
 * the line items' own `allocated_minor`, never the gross/original amount. */
function buildPayable(row: CandidateAssessmentRow, lines: LineItemRow[], asOfDate: string, maskName: boolean): PayableDTO {
  const principalMinor = lines.filter((l) => l.line_type === "PRINCIPAL").reduce((s, l) => s + l.amount_minor, 0n);
  const otherLinesMinor = lines.filter((l) => l.line_type !== "PRINCIPAL").reduce((s, l) => s + l.amount_minor, 0n);
  const allocatedMinor = lines.reduce((s, l) => s + l.allocated_minor, 0n);

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

  const outstandingMinor = derived.payableAmountMinor - allocatedMinor;
  const rfReference = row.reference_scheme_total_length === 17 ? rfEncode(row.psid) : null;

  // §8.2/finding I: expiry is computed live, on every read — never trusted
  // from a stale stored status. An expired assessment still resolves
  // ("remains resolvable"), just reported as EXPIRED (a real member of the
  // AssessmentStatus enum already).
  const isExpired = row.expiry_date !== null && asOfDate > row.expiry_date;
  const displayStatus = isExpired ? "EXPIRED" : row.status;

  return {
    psid: row.psid,
    rf_reference: rfReference,
    agency_code: row.agency_code,
    agency_name: row.agency_name,
    product_code: row.product_code,
    category: row.category,
    label: row.description,
    payable_amount_minor: toWireMinor(outstandingMinor),
    min_payable_minor: toWireMinor(row.allow_partial ? 0n : outstandingMinor),
    max_payable_minor: toWireMinor(outstandingMinor),
    surcharge_accrued_minor: toWireMinor(derived.surchargeAccruedMinor),
    discount_applied_minor: toWireMinor(derived.discountAppliedMinor),
    discount_expires_on: derived.discountExpiresOn,
    amount_valid_until: derived.amountValidUntil,
    currency: row.currency,
    due_date: row.due_date,
    expires_at: row.expiry_date ? `${row.expiry_date}T23:59:59Z` : null,
    status: displayStatus,
    partial_allowed: row.allow_partial,
    overpayment_allowed: row.overpayment_allowed,
    fee_amount_minor: toWireMinor(0n), // no fee_schedule module yet (out of Phase 1 scope)
    tax_on_fee_minor: toWireMinor(0n),
    fee_bearer: row.fee_bearer,
    payer_name_masked: row.payer_name_snapshot ? maskPayerName(row.payer_name_snapshot) : null,
    service_gating: row.service_gating,
    head_breakdown: lines.map((l) => ({
      revenue_head_code: l.code,
      line_type: l.line_type,
      tax_period: l.tax_period,
      amount_minor: toWireMinor(l.amount_minor),
      balance_minor: toWireMinor(l.amount_minor - l.allocated_minor),
    })),
  };
}

interface EligibilitySplit {
  eligible: CandidateAssessmentRow[];
  agencyUnavailableCount: number;
  channelIneligibleCount: number;
}

/** Finding I: agency/product/channel eligibility, checked live — never
 * silently folded into an empty result. */
function splitByEligibility(candidates: CandidateAssessmentRow[], channel: string, asOfDate: string): EligibilitySplit {
  const eligible: CandidateAssessmentRow[] = [];
  let agencyUnavailableCount = 0;
  let channelIneligibleCount = 0;

  for (const c of candidates) {
    if (c.agency_status !== "ACTIVE") {
      agencyUnavailableCount++;
      continue;
    }
    if (!c.allowed_channels.includes(channel)) {
      channelIneligibleCount++;
      continue;
    }
    // Product inactive / outside its effective window: excluded from results,
    // same as any other not-currently-payable state — no dedicated HTTP error
    // exists for this at /v1/resolve (only ChannelNotEligible/AgencyUnavailable
    // do), so over-inventing one would be scope creep.
    const withinEffectiveWindow = asOfDate >= c.product_effective_from && (c.product_effective_to === null || asOfDate <= c.product_effective_to);
    if (c.product_status !== "ACTIVE" || !withinEffectiveWindow) {
      continue;
    }
    eligible.push(c);
  }

  return { eligible, agencyUnavailableCount, channelIneligibleCount };
}

async function resolveByIndex(db: Kysely<Database>, keyType: string, keyValue: string): Promise<string[]> {
  const normalized = normalizeKeyValue(keyValue);
  const rows = await db
    .selectFrom("resolution_index")
    .select("assessment_id")
    .where("key_type", "=", keyType)
    .where("key_value_norm", "=", normalized)
    .where("is_open", "=", true)
    .execute();
  return rows.map((r) => r.assessment_id);
}

async function resolveByIdentity(db: Kysely<Database>, keyType: string, keyValue: string): Promise<string[]> {
  const hash = hashPrimaryId(keyType, keyValue);
  const payer = await db.selectFrom("payer").select("id").where("primary_id_hash", "=", hash).executeTakeFirst();
  if (!payer) return [];
  const rows = await db.selectFrom("assessment").select("id").where("payer_id", "=", payer.id).execute();
  return rows.map((r) => r.id);
}

async function resolveByRaastId(db: Kysely<Database>, raastIdValue: string): Promise<string[]> {
  const payer = await db.selectFrom("payer").select("id").where("raast_id_value", "=", raastIdValue).executeTakeFirst();
  if (!payer) return [];
  const rows = await db.selectFrom("assessment").select("id").where("payer_id", "=", payer.id).execute();
  return rows.map((r) => r.id);
}

async function buildOkOutcome(
  db: Kysely<Database>,
  assessmentIds: string[],
  channel: string,
  maskName: boolean,
  clock: Clock,
): Promise<ResolveOutcome> {
  if (assessmentIds.length === 0) {
    return { kind: "OK", payables: [], settled: [], resolutionToken: null, tokenExpiresAt: null };
  }

  const asOfDate = clock.now().toISOString().slice(0, 10);
  const candidates = await loadCandidateAssessments(db, assessmentIds);
  const { eligible, agencyUnavailableCount, channelIneligibleCount } = splitByEligibility(candidates, channel, asOfDate);

  if (eligible.length === 0 && candidates.length > 0) {
    // Every candidate was excluded on eligibility grounds — report the
    // specific reason rather than a bare empty 200 (finding I).
    if (agencyUnavailableCount > 0) return { kind: "AGENCY_UNAVAILABLE" };
    if (channelIneligibleCount > 0) return { kind: "CHANNEL_NOT_ELIGIBLE" };
    // (falls through to empty OK if only product-inactive excluded everything — see splitByEligibility's note)
  }

  const lineItemsByAssessment = await loadLineItems(db, eligible.map((c) => c.id));
  const openRows = eligible.filter((c) => (OPEN_STATUSES as readonly string[]).includes(c.status));
  const settledRows = eligible.filter((c) => c.status === "SETTLED");

  const payables = openRows.map((row) => buildPayable(row, lineItemsByAssessment.get(row.id) ?? [], asOfDate, maskName));

  const settled: SettledDTO[] = [];
  for (const row of settledRows) {
    const receipt = await findReceiptForPayment(db, row.id);
    if (!receipt) continue; // pre-minted at loader time (finding K) — if genuinely absent, don't claim one
    settled.push({ psid: row.psid, status: row.status, settled_on: receipt.businessDate, receipt_no: receipt.receiptNo, code: "ALREADY_SETTLED" });
  }

  let resolutionToken: string | null = null;
  let tokenExpiresAt: Date | null = null;
  if (payables.length > 0) {
    const minted = await mintResolutionToken(
      { payables: payables.map((p) => ({ psid: p.psid, amountMinor: String(p.payable_amount_minor) })) },
      clock,
    );
    resolutionToken = minted.token;
    tokenExpiresAt = minted.expiresAt;
  }

  return { kind: "OK", payables, settled, resolutionToken, tokenExpiresAt };
}

/**
 * §8.2's resolve pipeline. Step 3 ("rate/abuse check") is out of scope for
 * Phase 1 — no fraud/velocity module exists yet, and no gate test needs it.
 */
export async function resolveReference(db: Kysely<Database>, input: ResolveInput, clock: Clock): Promise<ResolveOutcome> {
  // Step 2: offline validation — zero DB queries below this line if it fails.
  if (!validateOffline(input.keyType, input.keyValue)) {
    return { kind: "INVALID_CHECKSUM" };
  }

  if ((STEP_UP_KEY_TYPES as readonly string[]).includes(input.keyType) && !hasStepUp(input.identityAssertion)) {
    return { kind: "AUTHENTICATION_REQUIRED" };
  }

  const maskName = !(FULL_DETAIL_KEY_TYPES as readonly string[]).includes(input.keyType);

  if (input.keyType === QR_KEY_TYPE) {
    let decoded;
    try {
      decoded = decodeQrPayload(input.keyValue);
    } catch (err) {
      if (err instanceof QrDecodeError && err.code === "QR_CRC_INVALID") return { kind: "QR_CRC_INVALID" };
      throw err;
    }
    if (!decoded.psid) {
      return { kind: "OK", payables: [], settled: [], resolutionToken: null, tokenExpiresAt: null };
    }
    const assessmentIds = await resolveByIndex(db, "PSID", decoded.psid);
    return buildOkOutcome(db, assessmentIds, input.channel, maskName, clock);
  }

  if ((IDENTITY_KEY_TYPES as readonly string[]).includes(input.keyType)) {
    const assessmentIds = await resolveByIdentity(db, input.keyType, input.keyValue);
    return buildOkOutcome(db, assessmentIds, input.channel, maskName, clock);
  }

  if (input.keyType === RAAST_KEY_TYPE) {
    const assessmentIds = await resolveByRaastId(db, input.keyValue);
    return buildOkOutcome(db, assessmentIds, input.channel, maskName, clock);
  }

  // Every other key type — the 11 §7.5-documented ones (minus the 3 identity
  // types and RAAST_ID/QR_PAYLOAD handled above) plus the 6 previously
  // "undocumented" enum values — resolves generically through
  // resolution_index, which the DB trigger populates for whatever secondary
  // keys each product actually declares (finding C, finding N).
  const assessmentIds = await resolveByIndex(db, input.keyType, input.keyValue);
  return buildOkOutcome(db, assessmentIds, input.channel, maskName, clock);
}

export { formatMinor };
