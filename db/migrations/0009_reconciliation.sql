-- P2G-Collection-Platform-Design.md §23 "RECONCILIATION" (schema only — the recon
-- engine itself is Phase 4; these tables sit empty until then).
CREATE TABLE recon_run (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no             BIGSERIAL UNIQUE,
  recon_type         TEXT NOT NULL,
  business_date      DATE NOT NULL,
  agency_id          UUID REFERENCES agency(id),
  rail               TEXT,
  status             TEXT NOT NULL DEFAULT 'PENDING',
  matched_count      INTEGER NOT NULL DEFAULT 0,
  matched_amount_minor BIGINT NOT NULL DEFAULT 0,
  break_count        INTEGER NOT NULL DEFAULT 0,
  break_amount_minor BIGINT NOT NULL DEFAULT 0,
  auto_match_rate_pct NUMERIC(6,3),
  control_totals     JSONB NOT NULL DEFAULT '{}',
  supersedes_run_id  UUID REFERENCES recon_run(id),
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ
);

CREATE TABLE recon_source_record (
  id             BIGSERIAL PRIMARY KEY,
  run_id         UUID NOT NULL REFERENCES recon_run(id),
  source         TEXT NOT NULL CHECK (source IN
                   ('PLATFORM','RAIL','SWITCH','BANK_STATEMENT','AGENCY_SUBLEDGER',
                    'TREASURY_ACK','CHANNEL_PARTNER','TILL')),
  file_id        UUID,
  line_no        INTEGER,
  raw_line       TEXT,
  parsed         JSONB NOT NULL,
  amount_minor   BIGINT,
  value_date     DATE,
  match_key      VARCHAR(80),
  matched        BOOLEAN NOT NULL DEFAULT FALSE,
  match_id       UUID
);
CREATE INDEX ix_rsr_run_unmatched ON recon_source_record (run_id, source) WHERE NOT matched;
CREATE INDEX ix_rsr_matchkey      ON recon_source_record (match_key);

CREATE TABLE recon_source_file (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT NOT NULL,
  partner_id   UUID,
  business_date DATE NOT NULL,
  filename     VARCHAR(300) NOT NULL,
  file_hash    BYTEA NOT NULL,
  declared_count INTEGER,
  declared_total_minor BIGINT,
  parsed_count   INTEGER,
  parsed_total_minor BIGINT,
  status       TEXT NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, file_hash)                        -- never ingest the same file twice
);

CREATE TABLE recon_break (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES recon_run(id),
  break_code         VARCHAR(4) NOT NULL,
  severity           TEXT NOT NULL,
  amount_minor       BIGINT NOT NULL,
  currency           CHAR(3) NOT NULL DEFAULT 'PKR',
  business_date      DATE NOT NULL,
  agency_id          UUID REFERENCES agency(id),
  rail               TEXT,
  channel            TEXT,
  source_a_record_id BIGINT REFERENCES recon_source_record(id),
  source_b_record_id BIGINT REFERENCES recon_source_record(id),
  payment_id         UUID REFERENCES payment(id),
  assessment_id      UUID REFERENCES assessment(id),
  narrative_raw      TEXT,
  suggested_resolution JSONB,
  status             TEXT NOT NULL DEFAULT 'OPEN',
  assigned_to_user_id UUID,
  sla_due_at         TIMESTAMPTZ,
  resolution_type    VARCHAR(30),
  adjustment_id      UUID,
  approval_id        UUID,
  resolved_at        TIMESTAMPTZ,
  resolved_by_user_id UUID,
  resolution_note    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_break_open ON recon_break (status, sla_due_at) WHERE status <> 'RESOLVED';
