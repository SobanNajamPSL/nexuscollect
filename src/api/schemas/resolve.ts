/**
 * Fastify route schemas transcribed from api/openapi.yaml's ResolveRequest /
 * ResolveResponse / Payable / Problem components (lines 2120-2352). Fastify
 * validates request/response against these via its built-in ajv instance —
 * this is the "generated against api/openapi.yaml" contract-fidelity
 * mechanism for Phase 1, without a separate codegen pipeline.
 */

// openapi.yaml ResolutionKeyType — all 17 values, so the schema boundary
// matches the contract even though only 11 have real resolution logic
// (the other 6 + QR_PAYLOAD return a 200 with empty arrays; see modules/resolution).
const RESOLUTION_KEY_TYPE = [
  "PSID", "CRN", "RF_REFERENCE", "VEHICLE_REG", "CNIC", "NTN", "STRN", "CASE_NO",
  "APPLICATION_NO", "GD_NO", "PROPERTY_ID", "INSTRUMENT_NO", "TENDER_REF",
  "CHASSIS_NO", "DL_NO", "QR_PAYLOAD", "RAAST_ID",
];

const CHANNEL = ["APP", "QR", "RTP", "BILLER", "ATM", "IBANKING", "OTC_CASH", "CHEQUE", "CARD", "WALLET", "AGENT", "API", "USSD", "POS"];

export const resolveRequestSchema = {
  type: "object",
  required: ["key_type", "key_value", "channel"],
  properties: {
    key_type: { type: "string", enum: RESOLUTION_KEY_TYPE },
    key_value: { type: "string", maxLength: 512 },
    channel: { type: "string", enum: CHANNEL },
    agency_code: { type: "string" },
    identity_assertion: {
      type: "object",
      properties: {
        asserted_by_institution: { type: "boolean" },
        step_up_token: { type: "string" },
      },
    },
    locale: { type: "string", enum: ["en", "ur"], default: "en" },
  },
} as const;

const payableSchema = {
  type: "object",
  properties: {
    psid: { type: "string" },
    rf_reference: { type: ["string", "null"] },
    agency_code: { type: "string" },
    agency_name: { type: "string" },
    product_code: { type: "string" },
    category: { type: "string" },
    label: { type: "string" },
    payable_amount_minor: { type: "string" },
    min_payable_minor: { type: "string" },
    max_payable_minor: { type: "string" },
    surcharge_accrued_minor: { type: "string" },
    discount_applied_minor: { type: "string" },
    discount_expires_on: { type: ["string", "null"] },
    amount_valid_until: { type: ["string", "null"] },
    currency: { type: "string" },
    due_date: { type: "string" },
    expires_at: { type: ["string", "null"] },
    status: { type: "string" },
    partial_allowed: { type: "boolean" },
    overpayment_allowed: { type: "boolean" },
    fee_amount_minor: { type: "string" },
    tax_on_fee_minor: { type: "string" },
    fee_bearer: { type: "string" },
    payer_name_masked: { type: ["string", "null"] },
    service_gating: { type: "string" },
    head_breakdown: {
      type: "array",
      items: {
        type: "object",
        properties: {
          revenue_head_code: { type: "string" },
          line_type: { type: "string" },
          tax_period: { type: ["string", "null"] },
          amount_minor: { type: "string" },
          balance_minor: { type: "string" },
        },
      },
    },
  },
};

export const resolveResponseSchema = {
  type: "object",
  properties: {
    resolution_token: { type: ["string", "null"] },
    token_expires_at: { type: ["string", "null"] },
    payables: { type: "array", items: payableSchema },
    settled: {
      type: "array",
      items: {
        type: "object",
        properties: {
          psid: { type: "string" },
          status: { type: "string" },
          settled_on: { type: "string" },
          receipt_no: { type: "string" },
          code: { type: "string" },
        },
      },
    },
  },
} as const;

export const problemSchema = {
  type: "object",
  required: ["type", "title", "status", "code"],
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    code: { type: "string" },
    detail: { type: "string" },
    instance: { type: "string" },
    correlation_id: { type: "string" },
    payer_message: { type: "string" },
    payer_message_ur: { type: "string" },
    retryable: { type: "boolean" },
  },
} as const;
