-- P2G-Collection-Platform-Design.md §23 "ASSESSMENT"
CREATE TABLE assessment (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  psid                     VARCHAR(30) NOT NULL UNIQUE,
  agency_id                UUID NOT NULL REFERENCES agency(id),
  product_id               UUID NOT NULL REFERENCES collection_product(id),
  payer_id                 UUID REFERENCES payer(id),
  payer_account_id         UUID REFERENCES payer_account(id),
  payer_snapshot           JSONB NOT NULL,
  external_ref             VARCHAR(80),
  description              VARCHAR(300) NOT NULL,
  currency                 CHAR(3) NOT NULL DEFAULT 'PKR',
  assessed_amount_minor    BIGINT NOT NULL CHECK (assessed_amount_minor >= 0),
  surcharge_accrued_minor  BIGINT NOT NULL DEFAULT 0,
  discount_applied_minor   BIGINT NOT NULL DEFAULT 0,
  payable_amount_minor     BIGINT NOT NULL,
  allocated_amount_minor   BIGINT NOT NULL DEFAULT 0,
  balance_minor            BIGINT NOT NULL,
  issue_date               DATE NOT NULL,
  due_date                 DATE NOT NULL,
  expiry_date              DATE,
  status                   TEXT NOT NULL CHECK (status IN
                             ('DRAFT','ISSUED','PARTIALLY_PAID','SETTLED','OVERDUE','EXPIRED',
                              'CANCELLED','AMENDED','WRITTEN_OFF','CLOSED')),
  allow_partial_override   BOOLEAN,
  service_gate_token       VARCHAR(60),
  service_gate_released_at TIMESTAMPTZ,
  source                   TEXT NOT NULL,
  version                  INTEGER NOT NULL DEFAULT 1,
  supersedes_id            UUID REFERENCES assessment(id),
  -- Not in the spec's abbreviated DDL, added for the demo-data loader: the CSV's own
  -- allocation waterfall used for this assessment (assessments.csv `waterfall` column),
  -- and its RF-11649 reference. Both are display/traceability data, not authoritative
  -- state, so they ride in metadata rather than as first-class columns.
  metadata                 JSONB NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Surcharge is a LINE ITEM inside assessed_amount_minor; surcharge_accrued_minor is a
  -- denormalised copy of that line total. Adding it here would double-count (see §6.4).
  CONSTRAINT ck_payable  CHECK (payable_amount_minor
                                = assessed_amount_minor - discount_applied_minor),
  CONSTRAINT ck_balance  CHECK (balance_minor = payable_amount_minor - allocated_amount_minor)
);
CREATE INDEX ix_assessment_agency_status ON assessment (agency_id, status)
  WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE');
CREATE INDEX ix_assessment_due       ON assessment (due_date) WHERE status <> 'SETTLED';
CREATE INDEX ix_assessment_metadata  ON assessment USING gin (metadata jsonb_path_ops);

CREATE TABLE assessment_line_item (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id       UUID NOT NULL REFERENCES assessment(id),
  seq                 SMALLINT NOT NULL,
  line_type           TEXT NOT NULL CHECK (line_type IN
                        ('PRINCIPAL','SURCHARGE','PENALTY','INTEREST','FEE','TAX_ON_FEE','ROUNDING','ARREAR')),
  revenue_head_id     UUID NOT NULL REFERENCES revenue_head(id),
  tax_period          VARCHAR(20),
  description         VARCHAR(200),
  amount_minor        BIGINT NOT NULL,
  allocated_minor     BIGINT NOT NULL DEFAULT 0,
  allocation_priority SMALLINT NOT NULL DEFAULT 100,
  UNIQUE (assessment_id, seq),
  CHECK (allocated_minor <= amount_minor OR amount_minor < 0)
);

-- Resolution index: THE table that makes §19.2's 300 ms budget achievable.
CREATE TABLE resolution_index (
  id                  BIGSERIAL PRIMARY KEY,
  agency_id           UUID NOT NULL REFERENCES agency(id),
  key_type            TEXT NOT NULL,
  key_value_norm      VARCHAR(80) NOT NULL,
  key_value_raw       VARCHAR(120) NOT NULL,
  assessment_id       UUID NOT NULL REFERENCES assessment(id),
  is_open             BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at          TIMESTAMPTZ,
  UNIQUE (key_type, key_value_norm, assessment_id)
);
CREATE INDEX ix_resolution_lookup ON resolution_index (key_type, key_value_norm) WHERE is_open;
