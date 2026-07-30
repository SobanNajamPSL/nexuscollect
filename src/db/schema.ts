import type { ColumnType, Generated, JSONColumnType } from "kysely";

/**
 * Kysely `Database` interface mirroring db/migrations/*.sql exactly (§23 of the
 * spec, plus the two "generate the remainder" tables: instrument, request_to_pay).
 * Every *_minor money column is typed `bigint` — CLAUDE.md hard rule #1. node-postgres's
 * int8 type parser is overridden in db/client.ts so these actually arrive as `bigint`
 * at runtime, not string or number.
 */

type Timestamp = ColumnType<Date, Date | string, Date | string>;
// NOT `Generated<Timestamp>` — Generated<S> = ColumnType<S, S | undefined, S>, so
// nesting it around an already-custom ColumnType only makes the *outer* ColumnType
// itself (not a Date) the insert type, one level too shallow. Writing the
// three-argument ColumnType directly, with `undefined` folded into its own Insert
// union, is Kysely's documented way to combine "has a DB default" with "accepts
// Date or an ISO string on insert."
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Dated = ColumnType<string, string, string>; // DATE columns as YYYY-MM-DD strings
// Kysely's JSONColumnType<T> constrains T to `object | null`; a bare `unknown` (the
// honest type for "some JSON, shape not modelled") doesn't satisfy that, so this is
// the closest honest stand-in — any JSON value actually stored in these columns is
// an object or an array, never a raw scalar.
type Jsonb = Record<string, unknown> | unknown[];

export interface AgencyTable {
  id: Generated<string>;
  code: string;
  name: string;
  tier: "FEDERAL" | "PROVINCIAL" | "LOCAL" | "AUTONOMOUS_BODY" | "JUDICIAL";
  jurisdiction: string;
  legal_entity_name: string;
  treasury_account_iban: string | null;
  treasury_bank_bic: string | null;
  consolidated_fund_ref: string | null;
  settlement_model: "COLLECTOR_OF_RECORD" | "PASS_THROUGH" | "HYBRID";
  timezone: Generated<string>;
  fiscal_year_start_month: Generated<number>;
  default_cutoff_time: Generated<string>;
  sweep_schedule: Generated<string>;
  status: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ReferenceSchemeTable {
  id: Generated<string>;
  code: string;
  agency_id: string | null;
  total_length: number;
  charset: Generated<"NUMERIC" | "ALPHANUMERIC_UPPER">;
  prefix: string | null;
  pattern_regex: string;
  checksum_algo: "DAMM" | "LUHN" | "MOD_97_10" | "MOD_11" | "NONE";
  sequence_digits: Generated<number>;
  random_digits: Generated<number>;
  collision_policy: Generated<string>;
  is_platform_minted: Generated<boolean>;
  created_at: GeneratedTimestamp;
}

export interface RevenueHeadTable {
  id: Generated<string>;
  agency_id: string;
  code: string;
  name: string;
  parent_id: string | null;
  fund: "FEDERAL_CONSOLIDATED" | "PROVINCIAL_CONSOLIDATED" | "PUBLIC_ACCOUNT" | "OTHER";
  object_class: "TAX_RECEIPT" | "NON_TAX_RECEIPT" | "DEPOSIT" | "FEE" | "FINE" | "OTHER";
  is_refundable_deposit: Generated<boolean>;
  effective_from: Dated;
  effective_to: Dated | null;
}

export interface CollectionProductTable {
  id: Generated<string>;
  agency_id: string;
  code: string;
  name: string;
  category: "TAX" | "DUTY" | "FINE" | "PENALTY" | "FEE" | "BILL" | "STAMP" | "DEPOSIT" | "MISC";
  reference_scheme_id: string;
  secondary_lookup_keys: Generated<JSONColumnType<unknown[]>>;
  amount_rule: "FIXED" | "ASSESSED" | "OPEN" | "MIN_MAX";
  fixed_amount_minor: bigint | null;
  min_amount_minor: bigint | null;
  max_amount_minor: bigint | null;
  allow_partial: Generated<boolean>;
  min_partial_pct: number | null;
  allow_overpayment: Generated<boolean>;
  overpay_treatment: Generated<"REJECT" | "CREDIT_ON_ACCOUNT" | "AUTO_REFUND" | "ABSORB">;
  underpay_tolerance_minor: Generated<bigint>;
  overpay_tolerance_minor: Generated<bigint>;
  rounding_rule: Generated<string>;
  allowed_channels: string[];
  allowed_instruments: Generated<string[]>;
  instrument_credit_policy: Generated<
    "ON_CLEARING" | "PROVISIONAL_ON_LODGEMENT" | "PROVISIONAL_WITH_GATE_HOLD"
  >;
  expiry_rule: Generated<JSONColumnType<Jsonb>>;
  surcharge_rule: JSONColumnType<Jsonb> | null;
  early_discount_rule: JSONColumnType<Jsonb> | null;
  fee_schedule_id: string | null;
  fee_bearer: Generated<"PAYER" | "AGENCY" | "SPLIT">;
  default_revenue_head_id: string;
  head_mapping: Generated<JSONColumnType<Jsonb>>;
  allocation_waterfall: Generated<
    "OLDEST_FIRST" | "PENALTY_FIRST" | "PRINCIPAL_FIRST" | "PRO_RATA" | "EXPLICIT_ONLY"
  >;
  underpay_policy: Generated<"HOLD_AS_UNAPPLIED" | "REJECT_AND_RETURN">;
  requires_payer_identification: Generated<boolean>;
  service_gating: Generated<"NONE" | "BLOCKS_SERVICE" | "RELEASES_GOODS">;
  deposit_refundable: Generated<boolean>;
  cutoff_time: string | null;
  status: Generated<string>;
  effective_from: Dated;
  effective_to: Dated | null;
}

export interface PayerTable {
  id: Generated<string>;
  payer_type: "INDIVIDUAL" | "SOLE_PROPRIETOR" | "AOP" | "COMPANY" | "GOVERNMENT" | "NON_RESIDENT";
  primary_id_type: string;
  primary_id_hash: Buffer;
  primary_id_enc: Buffer;
  primary_id_last4: string;
  name: string;
  msisdn_e164: string | null;
  email: string | null;
  raast_id_type: "MSISDN" | "EMAIL" | "NATIONAL_ID" | "FREE_TEXT" | null;
  raast_id_value: string | null;
  raast_id_expires_on: Dated | null;
  kyc_level: Generated<string>;
  risk_rating: Generated<string>;
  status: Generated<string>;
  created_at: GeneratedTimestamp;
}

export interface PayerAccountTable {
  id: Generated<string>;
  payer_id: string | null;
  agency_id: string;
  product_id: string;
  crn: string;
  account_label: string | null;
  attributes: Generated<JSONColumnType<Jsonb>>;
  status: Generated<string>;
}

export interface AssessmentTable {
  id: Generated<string>;
  psid: string;
  agency_id: string;
  product_id: string;
  payer_id: string | null;
  payer_account_id: string | null;
  payer_snapshot: JSONColumnType<Jsonb>;
  external_ref: string | null;
  description: string;
  currency: Generated<string>;
  assessed_amount_minor: bigint;
  surcharge_accrued_minor: Generated<bigint>;
  discount_applied_minor: Generated<bigint>;
  payable_amount_minor: bigint;
  allocated_amount_minor: Generated<bigint>;
  balance_minor: bigint;
  issue_date: Dated;
  due_date: Dated;
  expiry_date: Dated | null;
  status:
    | "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "SETTLED" | "OVERDUE" | "EXPIRED"
    | "CANCELLED" | "AMENDED" | "WRITTEN_OFF" | "CLOSED";
  allow_partial_override: boolean | null;
  service_gate_token: string | null;
  service_gate_released_at: Timestamp | null;
  source: string;
  version: Generated<number>;
  supersedes_id: string | null;
  metadata: Generated<JSONColumnType<Record<string, unknown>>>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AssessmentLineItemTable {
  id: Generated<string>;
  assessment_id: string;
  seq: number;
  line_type:
    | "PRINCIPAL" | "SURCHARGE" | "PENALTY" | "INTEREST" | "FEE" | "TAX_ON_FEE"
    | "ROUNDING" | "ARREAR";
  revenue_head_id: string;
  tax_period: string | null;
  description: string | null;
  amount_minor: bigint;
  allocated_minor: Generated<bigint>;
  allocation_priority: Generated<number>;
}

export interface ResolutionIndexTable {
  id: Generated<bigint>; // BIGSERIAL
  agency_id: string;
  key_type: string;
  key_value_norm: string;
  key_value_raw: string;
  assessment_id: string;
  is_open: Generated<boolean>;
  expires_at: Timestamp | null;
}

export interface PaymentIntentTable {
  id: Generated<string>;
  intent_reference: string;
  channel: string;
  initiating_institution_id: string | null;
  payer_id: string | null;
  third_party_payer: JSONColumnType<Jsonb> | null;
  requested_amount_minor: bigint;
  fee_amount_minor: Generated<bigint>;
  tax_on_fee_minor: Generated<bigint>;
  total_debit_minor: bigint;
  currency: Generated<string>;
  requested_allocations: JSONColumnType<Jsonb> | null;
  resolution_token_jti: string | null;
  derived_rule_version: string | null;
  quote_expires_at: Timestamp;
  status:
    | "CREATED" | "AUTHORISED" | "CAPTURED" | "COMPLETED" | "COMPLETED_LATE"
    | "EXPIRED" | "ABANDONED" | "FAILED";
  idempotency_key: string | null;
  created_at: GeneratedTimestamp;
}

export interface PaymentTable {
  id: Generated<string>;
  payment_reference: string;
  intent_id: string | null;
  agency_id: string | null;
  channel: string;
  rail:
    | "RAAST" | "IBFT_1LINK" | "PRISM_RTGS" | "PAYPAK" | "CARD_SCHEME"
    | "INTERNAL_BOOK" | "CASH" | "CHEQUE_CLEARING" | "WALLET";
  direction: Generated<"INBOUND" | "OUTBOUND">;
  instrument_id: string | null;
  bulk_batch_id: string | null;
  gross_amount_minor: bigint;
  fee_amount_minor: Generated<bigint>;
  net_to_agency_minor: bigint;
  unapplied_amount_minor: Generated<bigint>;
  currency: Generated<string>;
  status: "INITIATED" | "CONFIRMED" | "UNCERTAIN" | "FAILED" | "STUCK" | "REVERSED" | "PARTIALLY_REVERSED";
  finality: Generated<"PROVISIONAL" | "FINAL">;
  value_date: Dated;
  obligation_discharge_date: Dated;
  cutoff_reason: string | null;
  cutoff_rule_version: string | null;
  received_at: GeneratedTimestamp;
  confirmed_at: Timestamp | null;
  rail_e2e_id: string | null;
  rail_txn_id: string | null;
  rail_uetr: string | null;
  rail_instr_id: string | null;
  switch_stan: string | null;
  switch_rrn: string | null;
  acquirer_id: string | null;
  payer_account_masked: string | null;
  payer_bank_bic: string | null;
  remittance_raw: string | null;
  application_trace: JSONColumnType<Jsonb> | null;
  settlement_batch_id: string | null;
  duplicate_of_payment_id: string | null;
  uncertain_resolution_source: string | null;
  metadata: Generated<JSONColumnType<Record<string, unknown>>>;
  created_at: GeneratedTimestamp;
}

export interface PaymentAllocationTable {
  id: Generated<string>;
  payment_id: string;
  assessment_id: string;
  line_item_id: string;
  revenue_head_id: string;
  amount_minor: bigint;
  allocation_basis: "EXPLICIT" | "WATERFALL" | "MANUAL" | "SYSTEM_REALLOCATION";
  status: Generated<"APPLIED" | "REVERSED">;
  applied_at: GeneratedTimestamp;
  reversed_at: Timestamp | null;
  reversal_reason: string | null;
  applied_by_user_id: string | null;
  approval_id: string | null;
}

export interface InstrumentTable {
  id: Generated<string>;
  instrument_type: "CHEQUE" | "POST_DATED_CHEQUE" | "PAY_ORDER" | "DEMAND_DRAFT" | "CASH";
  instrument_number: string | null;
  drawee_bank_bic: string | null;
  drawee_bank_name: string | null;
  drawee_branch_code: string | null;
  drawer_name: string | null;
  drawer_account_masked: string | null;
  instrument_date: Dated | null;
  amount_minor: bigint;
  agency_id: string | null;
  lodged_at_branch: string | null;
  lodged_by_user: string | null;
  teller_batch_id: string | null;
  instrument_credit_policy: Generated<
    "ON_CLEARING" | "PROVISIONAL_ON_LODGEMENT" | "PROVISIONAL_WITH_GATE_HOLD"
  >;
  status: "LODGED" | "IN_CLEARING" | "CLEARED" | "RETURNED" | "HELD_POST_DATED";
  lodged_on: Dated | null;
  presented_on: Dated | null;
  clears_on_expected: Dated | null;
  cleared_on: Dated | null;
  returned_on: Dated | null;
  return_reason_code: string | null;
  dishonour_charge_minor: bigint | null;
  dishonour_charge_assessment_id: string | null;
  provisional_credit_given: Generated<boolean>;
  image_front_uri: string | null;
  image_back_uri: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface InstrumentLinkTable {
  id: Generated<string>;
  instrument_id: string;
  assessment_id: string;
  amount_minor: bigint;
}

export interface RequestToPayTable {
  id: Generated<string>;
  rtp_reference: string;
  agency_id: string;
  assessment_ids: string[];
  payer_id: string | null;
  payer_alias_type: "MSISDN" | "EMAIL" | "NATIONAL_ID" | "FREE_TEXT" | null;
  payer_alias_value: string | null;
  resolved_payer_iban: string | null;
  resolved_payer_bank_bic: string | null;
  payer_name: string | null;
  amount_minor: bigint;
  amount_modifiable: Generated<boolean>;
  requested_execution_date: Dated | null;
  expires_at: Timestamp;
  status:
    | "CREATED" | "SENT" | "DELIVERED" | "PRESENTED" | "ACCEPTED"
    | "ACCEPTED_FUTURE_DATED" | "ACCEPTED_PARTIAL" | "FULFILLED" | "FULFILLED_PARTIAL"
    | "FULFILLED_LATE" | "DECLINED" | "EXPIRED" | "CANCELLED" | "FAILED" | "UNDELIVERABLE";
  decline_reason_code: string | null;
  rail_msg_id: string | null;
  rail_status_msg_id: string | null;
  fulfilling_payment_id: string | null;
  reminder_count: Generated<number>;
  raast_id_expires_on: Dated | null;
  created_at: GeneratedTimestamp;
}

export interface ReceiptTable {
  id: Generated<string>;
  receipt_no: string;
  agency_id: string;
  payment_id: string;
  business_date: Dated;
  status: Generated<"VALID" | "VOIDED" | "REFUNDED">;
  issued_at: GeneratedTimestamp;
}

export interface LedgerAccountTable {
  code: string;
  name: string;
  account_type: "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY" | "MEMO";
  normal_balance: "DR" | "CR";
  agency_id: string | null;
  currency: Generated<string>;
  is_active: Generated<boolean>;
}

export interface JournalEntryTable {
  id: Generated<string>;
  entry_no: Generated<bigint>; // BIGSERIAL — returned as native bigint, see client.ts's int8 type parser
  event_type: string;
  source_type: string;
  source_id: string;
  sequence: Generated<number>;
  agency_id: string | null;
  value_date: Dated;
  posted_at: GeneratedTimestamp;
  narrative: string | null;
  reversal_of_entry_id: string | null;
  approval_id: string | null;
  correlation_id: string | null;
  hash_prev: Buffer | null;
  hash_self: Buffer | null;
}

export interface JournalLineTable {
  id: Generated<string>;
  entry_id: string;
  seq: number;
  account_code: string;
  direction: "DR" | "CR";
  amount_minor: bigint;
  currency: Generated<string>;
  revenue_head_id: string | null;
  dimension: Generated<JSONColumnType<Record<string, unknown>>>;
}

export interface IdempotencyRecordTable {
  institution_id: string;
  endpoint: string;
  idempotency_key: string;
  request_fingerprint: Buffer;
  state: "IN_PROGRESS" | "COMPLETE";
  response_status: number | null;
  response_body: JSONColumnType<Jsonb> | null;
  created_at: GeneratedTimestamp;
  completed_at: Timestamp | null;
}

export interface ReconRunTable {
  id: Generated<string>;
  run_no: Generated<bigint>; // BIGSERIAL
  recon_type: string;
  business_date: Dated;
  agency_id: string | null;
  rail: string | null;
  status: Generated<string>;
  matched_count: Generated<number>;
  matched_amount_minor: Generated<bigint>;
  break_count: Generated<number>;
  break_amount_minor: Generated<bigint>;
  auto_match_rate_pct: number | null;
  control_totals: Generated<JSONColumnType<Record<string, unknown>>>;
  supersedes_run_id: string | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
}

export interface ReconSourceRecordTable {
  id: Generated<bigint>; // BIGSERIAL
  run_id: string;
  source:
    | "PLATFORM" | "RAIL" | "SWITCH" | "BANK_STATEMENT" | "AGENCY_SUBLEDGER"
    | "TREASURY_ACK" | "CHANNEL_PARTNER" | "TILL";
  file_id: string | null;
  line_no: number | null;
  raw_line: string | null;
  parsed: JSONColumnType<Jsonb>;
  amount_minor: bigint | null;
  value_date: Dated | null;
  match_key: string | null;
  matched: Generated<boolean>;
  match_id: string | null;
}

export interface ReconSourceFileTable {
  id: Generated<string>;
  source: string;
  partner_id: string | null;
  business_date: Dated;
  filename: string;
  file_hash: Buffer;
  declared_count: number | null;
  declared_total_minor: bigint | null;
  parsed_count: number | null;
  parsed_total_minor: bigint | null;
  status: string;
  ingested_at: GeneratedTimestamp;
}

export interface ReconBreakTable {
  id: Generated<string>;
  run_id: string;
  break_code: string;
  severity: string;
  amount_minor: bigint;
  currency: Generated<string>;
  business_date: Dated;
  agency_id: string | null;
  rail: string | null;
  channel: string | null;
  source_a_record_id: bigint | null;
  source_b_record_id: bigint | null;
  payment_id: string | null;
  assessment_id: string | null;
  narrative_raw: string | null;
  suggested_resolution: JSONColumnType<Jsonb> | null;
  status: Generated<string>;
  assigned_to_user_id: string | null;
  sla_due_at: Timestamp | null;
  resolution_type: string | null;
  adjustment_id: string | null;
  approval_id: string | null;
  resolved_at: Timestamp | null;
  resolved_by_user_id: string | null;
  resolution_note: string | null;
  created_at: GeneratedTimestamp;
}

export interface ApprovalTable {
  id: Generated<string>;
  subject_type: string;
  subject_id: string;
  action: string;
  amount_minor: bigint | null;
  payload: JSONColumnType<Jsonb>;
  maker_user_id: string;
  maker_at: GeneratedTimestamp;
  checker_user_id: string | null;
  checker_at: Timestamp | null;
  state: Generated<"PENDING" | "APPROVED" | "REJECTED" | "EXPIRED">;
  comment: string | null;
}

export interface AuditLogTable {
  id: Generated<bigint>; // BIGSERIAL
  actor_type: "USER" | "SERVICE" | "SYSTEM" | "INSTITUTION";
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_json: JSONColumnType<Jsonb> | null;
  after_json: JSONColumnType<Jsonb> | null;
  ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  occurred_at: GeneratedTimestamp;
  hash_prev: Buffer | null;
  hash_self: Buffer;
}

export interface OutboxEventTable {
  id: Generated<bigint>; // BIGSERIAL
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  sequence: number;
  event_type: string;
  payload: JSONColumnType<Jsonb>;
  correlation_id: string | null;
  created_at: GeneratedTimestamp;
  published_at: Timestamp | null;
}

export interface SchemaMigrationsTable {
  filename: string;
  applied_at: GeneratedTimestamp;
}

export interface Database {
  agency: AgencyTable;
  reference_scheme: ReferenceSchemeTable;
  revenue_head: RevenueHeadTable;
  collection_product: CollectionProductTable;
  payer: PayerTable;
  payer_account: PayerAccountTable;
  assessment: AssessmentTable;
  assessment_line_item: AssessmentLineItemTable;
  resolution_index: ResolutionIndexTable;
  payment_intent: PaymentIntentTable;
  payment: PaymentTable;
  payment_allocation: PaymentAllocationTable;
  instrument: InstrumentTable;
  instrument_link: InstrumentLinkTable;
  request_to_pay: RequestToPayTable;
  receipt: ReceiptTable;
  ledger_account: LedgerAccountTable;
  journal_entry: JournalEntryTable;
  journal_line: JournalLineTable;
  idempotency_record: IdempotencyRecordTable;
  recon_run: ReconRunTable;
  recon_source_record: ReconSourceRecordTable;
  recon_source_file: ReconSourceFileTable;
  recon_break: ReconBreakTable;
  approval: ApprovalTable;
  audit_log: AuditLogTable;
  outbox_event: OutboxEventTable;
  schema_migrations: SchemaMigrationsTable;
}
