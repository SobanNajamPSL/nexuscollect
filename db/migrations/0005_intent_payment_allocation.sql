-- P2G-Collection-Platform-Design.md §23 "INTENT, PAYMENT, ALLOCATION"
CREATE TABLE payment_intent (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_reference      VARCHAR(30) NOT NULL UNIQUE,
  channel               TEXT NOT NULL,
  initiating_institution_id UUID,
  payer_id              UUID REFERENCES payer(id),
  third_party_payer     JSONB,
  requested_amount_minor BIGINT NOT NULL CHECK (requested_amount_minor > 0),
  fee_amount_minor      BIGINT NOT NULL DEFAULT 0,
  tax_on_fee_minor      BIGINT NOT NULL DEFAULT 0,
  total_debit_minor     BIGINT NOT NULL,
  currency              CHAR(3) NOT NULL DEFAULT 'PKR',
  requested_allocations JSONB,
  resolution_token_jti  UUID,
  derived_rule_version  VARCHAR(20),
  quote_expires_at      TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL CHECK (status IN
                          ('CREATED','AUTHORISED','CAPTURED','COMPLETED','COMPLETED_LATE',
                           'EXPIRED','ABANDONED','FAILED')),
  idempotency_key       VARCHAR(64),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_reference     VARCHAR(30) NOT NULL UNIQUE,
  intent_id             UUID REFERENCES payment_intent(id),
  agency_id             UUID REFERENCES agency(id),
  channel               TEXT NOT NULL,
  rail                  TEXT NOT NULL CHECK (rail IN
                          ('RAAST','IBFT_1LINK','PRISM_RTGS','PAYPAK','CARD_SCHEME',
                           'INTERNAL_BOOK','CASH','CHEQUE_CLEARING','WALLET')),
  direction             TEXT NOT NULL DEFAULT 'INBOUND' CHECK (direction IN ('INBOUND','OUTBOUND')),
  instrument_id         UUID,
  bulk_batch_id         UUID,
  gross_amount_minor    BIGINT NOT NULL CHECK (gross_amount_minor > 0),
  fee_amount_minor      BIGINT NOT NULL DEFAULT 0,
  net_to_agency_minor   BIGINT NOT NULL,
  unapplied_amount_minor BIGINT NOT NULL DEFAULT 0,
  currency              CHAR(3) NOT NULL DEFAULT 'PKR',
  status                TEXT NOT NULL CHECK (status IN
                          ('INITIATED','CONFIRMED','UNCERTAIN','FAILED','STUCK',
                           'REVERSED','PARTIALLY_REVERSED')),
  finality              TEXT NOT NULL DEFAULT 'FINAL' CHECK (finality IN ('PROVISIONAL','FINAL')),
  value_date                 DATE NOT NULL,
  obligation_discharge_date  DATE NOT NULL,
  cutoff_reason              VARCHAR(30),
  cutoff_rule_version        VARCHAR(20),
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at          TIMESTAMPTZ,
  rail_e2e_id           VARCHAR(35),
  rail_txn_id           VARCHAR(35),
  rail_uetr             UUID,
  rail_instr_id         VARCHAR(35),
  switch_stan           VARCHAR(12),
  switch_rrn            VARCHAR(20),
  acquirer_id           VARCHAR(20),
  payer_account_masked  VARCHAR(40),
  payer_bank_bic        VARCHAR(11),
  remittance_raw        TEXT,
  application_trace     JSONB,
  settlement_batch_id   UUID,
  duplicate_of_payment_id UUID REFERENCES payment(id),
  uncertain_resolution_source VARCHAR(30),
  -- Not in the spec's abbreviated DDL: a handful of demo-data columns (third-party
  -- payer detail, settlement cycle tag, recon-source provenance flags) that Phase 0
  -- has no business logic for yet. Parked here rather than silently dropped by the
  -- loader; §12's reconciliation engine (Phase 4) is expected to promote the
  -- provenance flags to first-class columns when it lands.
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The four anti-double-post constraints (§6.8)
CREATE UNIQUE INDEX ux_payment_rail_e2e ON payment (rail, rail_e2e_id)
  WHERE rail_e2e_id IS NOT NULL;
CREATE UNIQUE INDEX ux_payment_switch   ON payment (acquirer_id, switch_stan, switch_rrn, value_date)
  WHERE switch_stan IS NOT NULL;
CREATE UNIQUE INDEX ux_payment_intent   ON payment (intent_id)
  WHERE intent_id IS NOT NULL AND status NOT IN ('REVERSED','FAILED');
CREATE UNIQUE INDEX ux_payment_instr    ON payment (instrument_id)
  WHERE instrument_id IS NOT NULL;
CREATE INDEX ix_payment_valuedate ON payment (value_date, agency_id);
CREATE INDEX ix_payment_unapplied ON payment (received_at)
  WHERE unapplied_amount_minor > 0;
CREATE INDEX ix_payment_uncertain ON payment (received_at) WHERE status = 'UNCERTAIN';
CREATE INDEX ix_payment_remit_trgm ON payment USING gin (remittance_raw gin_trgm_ops);

CREATE TABLE payment_allocation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        UUID NOT NULL REFERENCES payment(id),
  assessment_id     UUID NOT NULL REFERENCES assessment(id),
  line_item_id      UUID NOT NULL REFERENCES assessment_line_item(id),
  revenue_head_id   UUID NOT NULL REFERENCES revenue_head(id),
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),
  allocation_basis  TEXT NOT NULL CHECK (allocation_basis IN
                      ('EXPLICIT','WATERFALL','MANUAL','SYSTEM_REALLOCATION')),
  status            TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','REVERSED')),
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at       TIMESTAMPTZ,
  reversal_reason   VARCHAR(60),
  applied_by_user_id UUID,
  approval_id       UUID,
  CHECK (allocation_basis <> 'MANUAL' OR approval_id IS NOT NULL)
);
CREATE INDEX ix_alloc_payment    ON payment_allocation (payment_id);
CREATE INDEX ix_alloc_assessment ON payment_allocation (assessment_id) WHERE status = 'APPLIED';
CREATE INDEX ix_alloc_head       ON payment_allocation (revenue_head_id, applied_at)
  WHERE status = 'APPLIED';
