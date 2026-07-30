-- P2G-Collection-Platform-Design.md §23 "PAYER"
CREATE TABLE payer (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_type          TEXT NOT NULL CHECK (payer_type IN
                        ('INDIVIDUAL','SOLE_PROPRIETOR','AOP','COMPANY','GOVERNMENT','NON_RESIDENT')),
  primary_id_type     TEXT NOT NULL,
  primary_id_hash     BYTEA NOT NULL,             -- keyed hash: searchable, not reversible
  primary_id_enc      BYTEA NOT NULL,             -- envelope-encrypted actual value
  primary_id_last4    CHAR(4) NOT NULL,
  name                VARCHAR(200) NOT NULL,
  msisdn_e164         VARCHAR(20),
  email               VARCHAR(200),
  raast_id_type       TEXT CHECK (raast_id_type IN ('MSISDN','EMAIL','NATIONAL_ID','FREE_TEXT')),
  raast_id_value      VARCHAR(120),
  raast_id_expires_on DATE,                       -- [V] Raast IDs support expiry
  kyc_level           TEXT NOT NULL DEFAULT 'NONE',
  risk_rating         TEXT NOT NULL DEFAULT 'LOW',
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (primary_id_type, primary_id_hash)
);
CREATE INDEX ix_payer_name_trgm ON payer USING gin (name gin_trgm_ops);
CREATE INDEX ix_payer_msisdn    ON payer (msisdn_e164);

CREATE TABLE payer_account (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id      UUID REFERENCES payer(id),
  agency_id     UUID NOT NULL REFERENCES agency(id),
  product_id    UUID NOT NULL REFERENCES collection_product(id),
  crn           VARCHAR(30) NOT NULL,
  account_label VARCHAR(200),
  attributes    JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (agency_id, crn)
);
