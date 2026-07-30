-- P2G-Collection-Platform-Design.md §23 "LEDGER", §10.5 balance + immutability enforcement
CREATE TABLE ledger_account (
  code           VARCHAR(20) PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  account_type   TEXT NOT NULL CHECK (account_type IN
                   ('ASSET','LIABILITY','INCOME','EXPENSE','EQUITY','MEMO')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DR','CR')),
  agency_id      UUID REFERENCES agency(id),
  currency       CHAR(3) NOT NULL DEFAULT 'PKR',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE journal_entry (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no            BIGSERIAL UNIQUE,
  event_type          VARCHAR(40) NOT NULL,
  source_type         VARCHAR(30) NOT NULL,
  source_id           UUID NOT NULL,
  sequence            SMALLINT NOT NULL DEFAULT 1,
  agency_id           UUID REFERENCES agency(id),
  value_date          DATE NOT NULL,
  posted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  narrative           VARCHAR(300),
  reversal_of_entry_id UUID REFERENCES journal_entry(id),
  approval_id         UUID,
  correlation_id      UUID,
  hash_prev           BYTEA,
  hash_self           BYTEA,
  UNIQUE (source_type, source_id, event_type, sequence)   -- idempotent posting
);

CREATE TABLE journal_line (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        UUID NOT NULL REFERENCES journal_entry(id),
  seq             SMALLINT NOT NULL,
  account_code    VARCHAR(20) NOT NULL REFERENCES ledger_account(code),
  direction       TEXT NOT NULL CHECK (direction IN ('DR','CR')),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        CHAR(3) NOT NULL DEFAULT 'PKR',
  revenue_head_id UUID REFERENCES revenue_head(id),
  dimension       JSONB NOT NULL DEFAULT '{}',
  UNIQUE (entry_id, seq)
);
CREATE INDEX ix_jl_account_date ON journal_line (account_code);
CREATE INDEX ix_jl_head         ON journal_line (revenue_head_id) WHERE revenue_head_id IS NOT NULL;

-- Balance + immutability enforcement (§10.5)
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE dr BIGINT; cr BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='DR' THEN amount_minor END),0),
         COALESCE(SUM(CASE WHEN direction='CR' THEN amount_minor END),0)
    INTO dr, cr FROM journal_line WHERE entry_id = NEW.entry_id;
  IF dr <> cr THEN
    RAISE EXCEPTION 'Unbalanced journal entry %: DR % <> CR %', NEW.entry_id, dr, cr;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

CREATE RULE je_no_update AS ON UPDATE TO journal_entry DO INSTEAD NOTHING;
CREATE RULE je_no_delete AS ON DELETE TO journal_entry DO INSTEAD NOTHING;
CREATE RULE jl_no_update AS ON UPDATE TO journal_line  DO INSTEAD NOTHING;
CREATE RULE jl_no_delete AS ON DELETE TO journal_line  DO INSTEAD NOTHING;
