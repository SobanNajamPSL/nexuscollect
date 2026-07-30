/**
 * Fastify route schemas transcribed from api/openapi.yaml's
 * CreateAssessmentRequest / Assessment / LineItemInput components, for
 * finding L's four assessment CRUD routes. Scoped narrowly to what finding L
 * asked for — not searchAssessments, bulkCreateAssessments, or the RtP/notify
 * fields, which exist in the contract but weren't requested.
 */

const LINE_TYPE = ["PRINCIPAL", "SURCHARGE", "PENALTY", "INTEREST", "FEE", "TAX_ON_FEE", "ROUNDING", "ARREAR"];
const AMEND_REASON_CODE = ["APPEAL_ALLOWED", "RECTIFICATION_ORDER", "CLERICAL_ERROR", "REASSESSMENT", "WAIVER_GRANTED", "DISCOUNT_APPLIED"];
const CANCEL_REASON_CODE = ["ISSUED_IN_ERROR", "DUPLICATE", "WITHDRAWN", "SUPERSEDED", "COURT_ORDER"];

const lineItemInputSchema = {
  type: "object",
  required: ["seq", "line_type", "revenue_head_code", "amount_minor"],
  properties: {
    seq: { type: "integer" },
    line_type: { type: "string", enum: LINE_TYPE },
    revenue_head_code: { type: "string" },
    tax_period: { type: ["string", "null"] },
    description: { type: "string" },
    amount_minor: { type: "integer" },
    allocation_priority: { type: "integer", default: 100 },
  },
} as const;

export const createAssessmentRequestSchema = {
  type: "object",
  required: ["product_code", "assessed_amount_minor", "issue_date", "due_date", "line_items"],
  properties: {
    product_code: { type: "string" },
    psid: { type: ["string", "null"] },
    external_ref: { type: "string" },
    payer_id: { type: "string" },
    payer: {
      type: "object",
      properties: {
        payer_type: { type: "string", enum: ["INDIVIDUAL", "SOLE_PROPRIETOR", "AOP", "COMPANY", "GOVERNMENT", "NON_RESIDENT"] },
        primary_id_type: { type: "string" },
        primary_id_value: { type: "string" },
        name: { type: "string" },
        msisdn_e164: { type: "string" },
        email: { type: "string" },
      },
    },
    description: { type: "string" },
    currency: { type: "string", default: "PKR" },
    assessed_amount_minor: { type: "integer" },
    issue_date: { type: "string" },
    due_date: { type: "string" },
    expiry_date: { type: ["string", "null"] },
    line_items: { type: "array", minItems: 1, items: lineItemInputSchema },
    metadata: { type: "object", additionalProperties: true },
  },
} as const;

export const amendAssessmentRequestSchema = {
  type: "object",
  required: ["reason_code", "expected_version"],
  properties: {
    expected_version: { type: "integer" },
    reason_code: { type: "string", enum: AMEND_REASON_CODE },
    due_date: { type: "string" },
    expiry_date: { type: "string" },
    description: { type: "string" },
    line_items: { type: "array", items: lineItemInputSchema },
    narrative: { type: "string" },
  },
} as const;

export const cancelAssessmentRequestSchema = {
  type: "object",
  required: ["reason_code"],
  properties: {
    reason_code: { type: "string", enum: CANCEL_REASON_CODE },
    narrative: { type: "string" },
  },
} as const;

const assessmentLineItemResponseSchema = {
  type: "object",
  properties: {
    seq: { type: "integer" },
    line_type: { type: "string" },
    revenue_head_code: { type: "string" },
    tax_period: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    amount_minor: { type: "integer" },
    allocated_minor: { type: "integer" },
    balance_minor: { type: "integer" },
    allocation_priority: { type: "integer" },
  },
} as const;

export const assessmentResponseSchema = {
  type: "object",
  properties: {
    psid: { type: "string" },
    rf_reference: { type: ["string", "null"] },
    agency_code: { type: "string" },
    product_code: { type: "string" },
    external_ref: { type: ["string", "null"] },
    description: { type: "string" },
    payer_name_snapshot: { type: ["string", "null"] },
    currency: { type: "string" },
    assessed_amount_minor: { type: "integer" },
    surcharge_accrued_minor: { type: "integer" },
    discount_applied_minor: { type: "integer" },
    payable_amount_minor: { type: "integer" },
    allocated_amount_minor: { type: "integer" },
    balance_minor: { type: "integer" },
    issue_date: { type: "string" },
    due_date: { type: "string" },
    expiry_date: { type: ["string", "null"] },
    status: { type: "string" },
    version: { type: "integer" },
    supersedes_psid_version: { type: ["integer", "null"] },
    service_gate_open: { type: "boolean" },
    line_items: { type: "array", items: assessmentLineItemResponseSchema },
    payments: { type: "array", items: {} }, // empty until Phase 2's payment capture exists
    metadata: { type: "object", additionalProperties: true },
    created_at: { type: "string" },
    // Amend-only fields (allOf in the contract) — harmless when absent elsewhere.
    overpayment_recognised_minor: { type: "integer" },
    refund_id: { type: ["string", "null"] },
  },
} as const;
