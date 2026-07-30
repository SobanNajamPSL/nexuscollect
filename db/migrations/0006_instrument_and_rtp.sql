-- §23's DDL is explicitly "abbreviated to the tables that carry the load-bearing
-- invariants" and instructs: "Generate the remainder from §6 using the same
-- conventions: id UUID PK DEFAULT gen_random_uuid(), created_at/updated_at
-- TIMESTAMPTZ NOT NULL DEFAULT now(), money as BIGINT minor units, enums as TEXT
-- with CHECK constraints, and agency_id on every tenant-scoped table for RLS."
--
-- `instrument` and `request_to_pay` are described narratively in §6.12/§6.4/§8.8/§9.2
-- and appear in demo-data (instruments.csv, requests_to_pay.csv) but have no DDL
-- block of their own. Generated here following those conventions.

CREATE TABLE instrument (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- §6: "cheque, pay order, demand draft, cash." POST_DATED_CHEQUE added after
  -- checking instruments.csv, which uses it as a distinct type (not just a status)
  -- for the one post-dated cheque in the demo pack.
  instrument_type           TEXT NOT NULL CHECK (instrument_type IN
                              ('CHEQUE','POST_DATED_CHEQUE','PAY_ORDER','DEMAND_DRAFT','CASH')),
  instrument_number         VARCHAR(40),
  drawee_bank_bic           VARCHAR(11),
  drawee_bank_name          VARCHAR(200),
  drawee_branch_code        VARCHAR(20),
  drawer_name               VARCHAR(200),
  drawer_account_masked     VARCHAR(40),
  instrument_date           DATE,
  amount_minor              BIGINT NOT NULL CHECK (amount_minor > 0),
  -- Derived at load/lodgement time from the first linked assessment's agency, for RLS.
  -- An instrument can only be lodged against assessments of a single agency in this
  -- build (§8.8 does not describe a cross-agency cheque).
  agency_id                 UUID REFERENCES agency(id),
  lodged_at_branch          VARCHAR(40),
  lodged_by_user            VARCHAR(80),
  teller_batch_id           VARCHAR(40),
  instrument_credit_policy  TEXT NOT NULL DEFAULT 'ON_CLEARING' CHECK (instrument_credit_policy IN
                              ('ON_CLEARING','PROVISIONAL_ON_LODGEMENT','PROVISIONAL_WITH_GATE_HOLD')),
  status                    TEXT NOT NULL CHECK (status IN
                              ('LODGED','IN_CLEARING','CLEARED','RETURNED','HELD_POST_DATED')),
  lodged_on                 DATE,
  presented_on              DATE,
  clears_on_expected        DATE,
  cleared_on                DATE,
  returned_on               DATE,
  return_reason_code        VARCHAR(30),
  dishonour_charge_minor    BIGINT,
  dishonour_charge_assessment_id UUID REFERENCES assessment(id),
  provisional_credit_given  BOOLEAN NOT NULL DEFAULT FALSE,
  image_front_uri           TEXT,
  image_back_uri            TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_instrument_agency_status ON instrument (agency_id, status);

-- §6.4's many-to-many join pattern applied to instruments: one cheque can cover
-- several assessments, each for a distinct amount (demo-data's linked_assessment_ids /
-- linked_psids / linked_amounts pipe-triples), so this is a proper join table rather
-- than three parallel arrays.
CREATE TABLE instrument_link (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id  UUID NOT NULL REFERENCES instrument(id),
  assessment_id  UUID NOT NULL REFERENCES assessment(id),
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  UNIQUE (instrument_id, assessment_id)
);
CREATE INDEX ix_instrument_link_assessment ON instrument_link (assessment_id);

CREATE TABLE request_to_pay (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rtp_reference             VARCHAR(40) NOT NULL UNIQUE,
  agency_id                 UUID NOT NULL REFERENCES agency(id),
  assessment_ids            UUID[] NOT NULL,
  payer_id                  UUID REFERENCES payer(id),
  payer_alias_type          TEXT CHECK (payer_alias_type IN
                              ('MSISDN','EMAIL','NATIONAL_ID','FREE_TEXT')),
  payer_alias_value         VARCHAR(120),
  resolved_payer_iban       VARCHAR(34),
  resolved_payer_bank_bic   VARCHAR(11),
  payer_name                VARCHAR(200),
  amount_minor              BIGINT NOT NULL CHECK (amount_minor > 0),
  amount_modifiable         BOOLEAN NOT NULL DEFAULT FALSE,
  requested_execution_date  DATE,
  expires_at                TIMESTAMPTZ NOT NULL,
  -- §9.2's full 15-state machine, transcribed exactly (this migration originally
  -- guessed a shorter/wrong list before being checked against both the spec and
  -- demo-data — see requests_to_pay.csv for 8 of these actually in use).
  status                    TEXT NOT NULL CHECK (status IN
                              ('CREATED','SENT','DELIVERED','PRESENTED','ACCEPTED',
                               'ACCEPTED_FUTURE_DATED','ACCEPTED_PARTIAL','FULFILLED',
                               'FULFILLED_PARTIAL','FULFILLED_LATE','DECLINED','EXPIRED',
                               'CANCELLED','FAILED','UNDELIVERABLE')),
  decline_reason_code       VARCHAR(30),
  rail_msg_id               VARCHAR(35),
  rail_status_msg_id        VARCHAR(35),
  -- Resolved from demo-data's fulfilling_payment_reference during load. The generator's
  -- own invariant (verify() check 15) is fulfilling_payment.rail_e2e_id == rtp_reference,
  -- so no separate EndToEndId column is needed here.
  fulfilling_payment_id     UUID REFERENCES payment(id),
  reminder_count            SMALLINT NOT NULL DEFAULT 0,
  raast_id_expires_on       DATE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_rtp_agency_status ON request_to_pay (agency_id, status);
