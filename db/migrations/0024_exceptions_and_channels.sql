-- §14 (refunds/reversal/recall/dispute), §15.6 (deposits), §8.9-8.11 (card/
-- wallet/mandate) — Prompt 6.

-- §14.1/14.2: refund. `funding_source` distinguishes platform-held money
-- (the platform can refund unilaterally) from agency-funded (already swept —
-- the agency owns the decision, §14.1).
CREATE TABLE refund (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_reference        VARCHAR(30) NOT NULL UNIQUE,
  payment_id              UUID NOT NULL REFERENCES payment(id),
  amount_minor            BIGINT NOT NULL CHECK (amount_minor > 0),
  reason_code             TEXT NOT NULL CHECK (reason_code IN
                            ('OVERPAYMENT','DUPLICATE','CANCELLED_SERVICE','ASSESSMENT_AMENDED',
                             'ERRONEOUS_PAYMENT','DEPOSIT_RELEASE','COURT_ORDER')),
  -- §14.1: "A refund of an allocated payment must reverse the allocation...
  -- unless the refund is of SURPLUS ONLY, in which case allocations are
  -- untouched." Two distinct paths, both real.
  mode                    TEXT NOT NULL CHECK (mode IN ('SURPLUS_ONLY','FULL_REVERSAL')),
  funding_source          TEXT NOT NULL CHECK (funding_source IN ('PLATFORM_HELD','AGENCY_FUNDED')),
  -- §14.1/§8.14: defaults to the original debit account; any change needs an
  -- approved override — this is the primary refund-fraud vector.
  beneficiary_overridden  BOOLEAN NOT NULL DEFAULT FALSE,
  beneficiary_account_masked VARCHAR(40),
  status                  TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN
                            ('PENDING_APPROVAL','APPROVED','REJECTED','PAID','FAILED')),
  approval_id             UUID REFERENCES approval(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                 TIMESTAMPTZ
);
CREATE INDEX ix_refund_payment ON refund (payment_id);

-- §14.7: card/wallet chargeback.
CREATE TABLE dispute (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            UUID NOT NULL REFERENCES payment(id),
  scheme_reason_code    VARCHAR(20) NOT NULL,
  amount_minor          BIGINT NOT NULL CHECK (amount_minor > 0),
  status                TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN
                          ('RECEIVED','EVIDENCE_SUBMITTED','WON','LOST','LIABILITY_ASSIGNED')),
  liability             TEXT CHECK (liability IN ('OPERATOR','AGENCY','SHARED')),
  representment_deadline DATE,
  evidence_bundle       JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);

-- §14.4: recall (camt.056/camt.029).
CREATE TABLE recall_request (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        UUID NOT NULL REFERENCES payment(id),
  requested_reason  VARCHAR(100),
  status            TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN
                      ('RECEIVED','RETURNED','AGENCY_DECISION_PENDING','REJECTED')),
  camt029_reason    VARCHAR(60),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);

-- §8.11: "A mandate is best implemented as an automated RtP with pre-granted
-- consent... reuse the RtP machinery." This table holds the standing
-- authorisation; each actual collection is a normal request_to_pay row this
-- mandate creates and auto-accepts on the payer's behalf.
CREATE TABLE mandate (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_reference     VARCHAR(30) NOT NULL UNIQUE,
  payer_id              UUID NOT NULL REFERENCES payer(id),
  product_id            UUID NOT NULL REFERENCES collection_product(id),
  max_amount_minor      BIGINT NOT NULL CHECK (max_amount_minor > 0),
  frequency             TEXT NOT NULL CHECK (frequency IN ('MONTHLY','QUARTERLY','ANNUAL')),
  first_collection_date DATE NOT NULL,
  final_collection_date DATE,
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CANCELLED')),
  retry_count           SMALLINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §8.9: card/wallet — never a PAN. Only a gateway token + BIN6 + last4.
CREATE TABLE card_token (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id      UUID REFERENCES payer(id),
  gateway_token VARCHAR(100) NOT NULL,
  bin6          CHAR(6) NOT NULL,
  last4         CHAR(4) NOT NULL,
  scheme        TEXT CHECK (scheme IN ('PAYPAK','VISA','MASTERCARD','UNIONPAY')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_account (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id        UUID REFERENCES payer(id),
  wallet_provider VARCHAR(40) NOT NULL,
  wallet_msisdn_masked VARCHAR(20),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §8.10: bulk corporate file payment. `payment.bulk_batch_id` already exists
-- (migration 0005) — this table is the batch header + validation record the
-- column was always meant to reference.
CREATE TABLE bulk_batch (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bulk_reference        VARCHAR(30) NOT NULL UNIQUE,
  file_hash             VARCHAR(64) NOT NULL UNIQUE,
  submitted_by_institution_id UUID,
  declared_row_count    INTEGER NOT NULL,
  declared_total_minor  BIGINT NOT NULL,
  on_amount_mismatch    TEXT NOT NULL DEFAULT 'REJECT_ALL' CHECK (on_amount_mismatch IN
                          ('REJECT_ALL','APPLY_PRO_RATA','APPLY_IN_ORDER_UNTIL_EXHAUSTED')),
  status                TEXT NOT NULL DEFAULT 'VALIDATING' CHECK (status IN
                          ('VALIDATING','VALIDATED','REJECTED','CONFIRMED','APPLIED')),
  rejection_reason      TEXT,
  payment_id            UUID REFERENCES payment(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bulk_batch_row (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      UUID NOT NULL REFERENCES bulk_batch(id),
  row_no        INTEGER NOT NULL,
  psid          VARCHAR(20) NOT NULL,
  amount_minor  BIGINT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('VALID','INVALID')),
  error_code    VARCHAR(40),
  UNIQUE (batch_id, row_no)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON refund TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dispute TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON recall_request TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mandate TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON card_token TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON wallet_account TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_batch TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_batch_row TO nexuscollect_app;

-- §14.3 step 7 / §13.4: a payment reversed AFTER its allocations were swept
-- needs a receivable from the agency, not a silent undo. Marks which payments
-- have actually been swept (Phase 4's runSweep doesn't tag individual
-- payments today — this closes that gap) via the sweep-payment's own linkage.
ALTER TABLE payment_allocation ADD COLUMN swept_in_payment_id UUID REFERENCES payment(id);
