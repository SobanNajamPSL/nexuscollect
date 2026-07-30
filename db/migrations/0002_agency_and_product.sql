-- P2G-Collection-Platform-Design.md §23 "AGENCY & PRODUCT"
CREATE TABLE agency (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   VARCHAR(12)  NOT NULL UNIQUE,
  name                   VARCHAR(200) NOT NULL,
  tier                   TEXT NOT NULL CHECK (tier IN
                           ('FEDERAL','PROVINCIAL','LOCAL','AUTONOMOUS_BODY','JUDICIAL')),
  jurisdiction           VARCHAR(10)  NOT NULL,
  legal_entity_name      VARCHAR(200) NOT NULL,
  treasury_account_iban  VARCHAR(34),
  treasury_bank_bic      VARCHAR(11),
  consolidated_fund_ref  VARCHAR(50),
  settlement_model       TEXT NOT NULL CHECK (settlement_model IN
                           ('COLLECTOR_OF_RECORD','PASS_THROUGH','HYBRID')),
  timezone               VARCHAR(40) NOT NULL DEFAULT 'Asia/Karachi',
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 7,
  default_cutoff_time    TIME NOT NULL DEFAULT '18:00',
  sweep_schedule         TEXT NOT NULL DEFAULT 'T1_MORNING',
  status                 TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reference_scheme (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           VARCHAR(30) NOT NULL UNIQUE,
  agency_id      UUID REFERENCES agency(id),
  total_length   SMALLINT NOT NULL,
  charset        TEXT NOT NULL DEFAULT 'NUMERIC'
                   CHECK (charset IN ('NUMERIC','ALPHANUMERIC_UPPER')),
  prefix         VARCHAR(8),
  pattern_regex  VARCHAR(200) NOT NULL,
  checksum_algo  TEXT NOT NULL CHECK (checksum_algo IN
                   ('DAMM','LUHN','MOD_97_10','MOD_11','NONE')),
  sequence_digits SMALLINT NOT NULL DEFAULT 6,
  random_digits   SMALLINT NOT NULL DEFAULT 4,
  collision_policy TEXT NOT NULL DEFAULT 'REJECT_AMBIGUOUS',
  is_platform_minted BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revenue_head (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      UUID NOT NULL REFERENCES agency(id),
  code           VARCHAR(20) NOT NULL,
  name           VARCHAR(200) NOT NULL,
  parent_id      UUID REFERENCES revenue_head(id),
  fund           TEXT NOT NULL CHECK (fund IN
                   ('FEDERAL_CONSOLIDATED','PROVINCIAL_CONSOLIDATED','PUBLIC_ACCOUNT','OTHER')),
  object_class   TEXT NOT NULL CHECK (object_class IN
                   ('TAX_RECEIPT','NON_TAX_RECEIPT','DEPOSIT','FEE','FINE','OTHER')),
  is_refundable_deposit BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  UNIQUE (agency_id, code, effective_from)
);

CREATE TABLE collection_product (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID NOT NULL REFERENCES agency(id),
  code                  VARCHAR(30) NOT NULL,
  name                  VARCHAR(200) NOT NULL,
  category              TEXT NOT NULL CHECK (category IN
                          ('TAX','DUTY','FINE','PENALTY','FEE','BILL','STAMP','DEPOSIT','MISC')),
  reference_scheme_id   UUID NOT NULL REFERENCES reference_scheme(id),
  secondary_lookup_keys JSONB NOT NULL DEFAULT '[]',
  amount_rule           TEXT NOT NULL CHECK (amount_rule IN ('FIXED','ASSESSED','OPEN','MIN_MAX')),
  fixed_amount_minor    BIGINT,
  min_amount_minor      BIGINT,
  max_amount_minor      BIGINT,
  allow_partial         BOOLEAN NOT NULL DEFAULT FALSE,
  min_partial_pct       NUMERIC(5,2),
  allow_overpayment     BOOLEAN NOT NULL DEFAULT FALSE,
  overpay_treatment     TEXT NOT NULL DEFAULT 'REJECT' CHECK (overpay_treatment IN
                          ('REJECT','CREDIT_ON_ACCOUNT','AUTO_REFUND','ABSORB')),
  underpay_tolerance_minor BIGINT NOT NULL DEFAULT 0,
  overpay_tolerance_minor  BIGINT NOT NULL DEFAULT 0,
  rounding_rule         TEXT NOT NULL DEFAULT 'NONE',
  allowed_channels      TEXT[] NOT NULL,
  allowed_instruments   TEXT[] NOT NULL DEFAULT '{}',
  instrument_credit_policy TEXT NOT NULL DEFAULT 'ON_CLEARING' CHECK (instrument_credit_policy IN
                          ('ON_CLEARING','PROVISIONAL_ON_LODGEMENT','PROVISIONAL_WITH_GATE_HOLD')),
  expiry_rule           JSONB NOT NULL DEFAULT '{"type":"NEVER"}',
  surcharge_rule        JSONB,
  early_discount_rule   JSONB,
  fee_schedule_id       UUID,
  fee_bearer            TEXT NOT NULL DEFAULT 'AGENCY' CHECK (fee_bearer IN ('PAYER','AGENCY','SPLIT')),
  default_revenue_head_id UUID NOT NULL REFERENCES revenue_head(id),
  head_mapping          JSONB NOT NULL DEFAULT '{}',
  allocation_waterfall  TEXT NOT NULL DEFAULT 'PENALTY_FIRST' CHECK (allocation_waterfall IN
                          ('OLDEST_FIRST','PENALTY_FIRST','PRINCIPAL_FIRST','PRO_RATA','EXPLICIT_ONLY')),
  underpay_policy       TEXT NOT NULL DEFAULT 'HOLD_AS_UNAPPLIED' CHECK (underpay_policy IN
                          ('HOLD_AS_UNAPPLIED','REJECT_AND_RETURN')),
  requires_payer_identification BOOLEAN NOT NULL DEFAULT TRUE,
  service_gating        TEXT NOT NULL DEFAULT 'NONE' CHECK (service_gating IN
                          ('NONE','BLOCKS_SERVICE','RELEASES_GOODS')),
  deposit_refundable    BOOLEAN NOT NULL DEFAULT FALSE,
  cutoff_time           TIME,
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  UNIQUE (agency_id, code, effective_from),
  CHECK (amount_rule <> 'FIXED' OR fixed_amount_minor IS NOT NULL),
  CHECK (NOT allow_partial OR allow_partial IS NOT NULL)
);
