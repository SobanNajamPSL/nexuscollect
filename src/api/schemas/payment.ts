/**
 * Fastify route schemas transcribed from api/openapi.yaml's
 * CreatePaymentIntentRequest / ConfirmPaymentRequest / PaymentIntent /
 * Payment components, for Phase 2's apply pipeline routes. Settlement-cycle/
 * settlement-status fields are Phase 5 (treasury/sweep) territory and are
 * omitted rather than half-implemented.
 */
const CHANNEL = ["APP", "QR", "RTP", "BILLER", "ATM", "IBANKING", "OTC_CASH", "CHEQUE", "CARD", "WALLET", "AGENT", "API", "USSD", "POS"];
const RAIL = ["RAAST", "IBFT_1LINK", "PRISM_RTGS", "PAYPAK", "CARD_SCHEME", "INTERNAL_BOOK", "CASH", "CHEQUE_CLEARING", "WALLET"];

export const createPaymentIntentRequestSchema = {
  type: "object",
  required: ["resolution_token", "channel"],
  properties: {
    resolution_token: { type: "string" },
    channel: { type: "string", enum: CHANNEL },
    payer_id: { type: "string" },
  },
} as const;

export const paymentIntentResponseSchema = {
  type: "object",
  properties: {
    intent_reference: { type: "string" },
    status: { type: "string" },
    channel: { type: "string" },
    requested_amount_minor: { type: "integer" },
    total_debit_minor: { type: "integer" },
    currency: { type: "string" },
    quote_expires_at: { type: "string" },
  },
} as const;

export const confirmPaymentRequestSchema = {
  type: "object",
  required: ["channel", "rail", "gross_amount_minor", "value_date", "obligation_discharge_date"],
  properties: {
    intent_reference: { type: ["string", "null"] },
    channel: { type: "string", enum: CHANNEL },
    rail: { type: "string", enum: RAIL },
    gross_amount_minor: { type: "integer" },
    currency: { type: "string", default: "PKR" },
    value_date: { type: "string" },
    obligation_discharge_date: { type: "string" },
    rail_e2e_id: { type: "string" },
    switch_stan: { type: "string" },
    switch_rrn: { type: "string" },
    acquirer_id: { type: "string" },
    instrument_id: { type: "string" },
    payer_account_masked: { type: "string" },
    payer_bank_bic: { type: "string" },
    remittance_raw: { type: "string" },
    explicit_allocations: {
      type: "array",
      items: { type: "object", required: ["psid", "amount_minor"], properties: { psid: { type: "string" }, line_type: { type: "string" }, revenue_head_code: { type: "string" }, amount_minor: { type: "integer" } } },
    },
    // Test/demo-only: no real rail exists to poll for a capture outcome, so
    // callers state what it resolved to (see modules/payment's own doc comment).
    capture_outcome: { type: "string", enum: ["CONFIRMED", "UNCERTAIN", "FAILED"] },
    // §8.12/§14.1: someone paying another's obligation (a lawyer, an agent,
    // a family member). Optional — most payments have no third party.
    third_party_payer: {
      type: "object",
      required: ["name", "masked_id", "relationship"],
      properties: { name: { type: "string" }, masked_id: { type: "string" }, relationship: { type: "string" } },
    },
  },
} as const;

export const paymentResponseSchema = {
  type: "object",
  properties: {
    payment_reference: { type: "string" },
    status: { type: "string" },
    gross_amount_minor: { type: "integer" },
    unapplied_amount_minor: { type: "integer" },
    currency: { type: "string" },
    value_date: { type: "string" },
    settled_psids: { type: "array", items: { type: "string" } },
    application_trace: { type: "object", additionalProperties: true },
  },
} as const;

export const reversePaymentRequestSchema = {
  type: "object",
  required: ["reason"],
  properties: { reason: { type: "string" } },
} as const;

export const receiptResponseSchema = {
  type: "object",
  properties: {
    receipt_no: { type: "string" },
    business_date: { type: "string" },
    status: { type: "string" },
  },
} as const;
