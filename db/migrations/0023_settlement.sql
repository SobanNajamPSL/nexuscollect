-- §13: settlement cycles, treasury scrolls, and period close (Prompt 5).

-- §13.5's scroll is "one line per allocation, not per payment", ordered
-- exactly as each allocation was produced. `payment_allocation` had no
-- ordinal of its own — a plain identity column captures real insertion
-- order (which, for the historical demo-data loader, is exactly the CSV's
-- own row order, since the loader inserts one row per CSV line,
-- sequentially, inside one transaction).
ALTER TABLE payment_allocation ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;

-- §13.2
CREATE TABLE settlement_cycle (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rail                 TEXT NOT NULL,
  business_date        DATE NOT NULL,
  cycle_no             SMALLINT NOT NULL,
  window_open_at       TIMESTAMPTZ,
  cutoff_at            TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CUT_OFF','NETTING','SETTLED','FAILED')),
  gross_in_minor       BIGINT NOT NULL DEFAULT 0,
  gross_out_minor      BIGINT NOT NULL DEFAULT 0,
  net_minor            BIGINT NOT NULL DEFAULT 0,
  participant_position JSONB,
  rail_settlement_ref  VARCHAR(40),
  settled_at           TIMESTAMPTZ,
  UNIQUE (rail, business_date, cycle_no)
);

-- §13.5
CREATE TABLE scroll (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id           UUID NOT NULL REFERENCES agency(id),
  business_date       DATE NOT NULL,
  scroll_reference    VARCHAR(40) NOT NULL UNIQUE,
  sequence_no         SMALLINT NOT NULL,
  format_version      VARCHAR(10) NOT NULL DEFAULT 'v1.0',
  record_count        INTEGER NOT NULL,
  control_total_minor BIGINT NOT NULL,
  detail_sha256       VARCHAR(64) NOT NULL,
  generated_at        TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED','TRANSMITTED','ACKNOWLEDGED','REJECTED')),
  transmitted_at      TIMESTAMPTZ,
  acknowledged_at     TIMESTAMPTZ,
  ack_status          VARCHAR(20),
  supersedes_scroll_id UUID REFERENCES scroll(id),
  UNIQUE (agency_id, business_date, sequence_no)
);

-- §13.5's detail line, one per allocation.
CREATE TABLE scroll_line (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scroll_id                UUID NOT NULL REFERENCES scroll(id),
  line_no                  INTEGER NOT NULL,
  revenue_head_code        VARCHAR(10) NOT NULL,
  psid                     VARCHAR(20) NOT NULL,
  payer_name               VARCHAR(200) NOT NULL,
  payer_id_masked          VARCHAR(40),
  tax_period               VARCHAR(20),
  amount_minor             BIGINT NOT NULL,
  payment_reference        VARCHAR(30) NOT NULL,
  receipt_no               VARCHAR(30),
  channel                  TEXT NOT NULL,
  rail                     TEXT NOT NULL,
  value_date               DATE NOT NULL,
  instrument_type          VARCHAR(20),
  instrument_no_or_branch  VARCHAR(20),
  UNIQUE (scroll_id, line_no)
);

-- §13.6. Platform-wide, one row per closed accounting period. Reopening is
-- structurally impossible: there is no UPDATE path back to OPEN — the
-- application layer never exposes one, and `closed_at` is only ever set once.
CREATE TABLE accounting_period (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_at     TIMESTAMPTZ,
  closed_by     VARCHAR(80),
  UNIQUE (period_start, period_end)
);

-- Rule enforced structurally, mirroring the append-only ledger pattern
-- elsewhere in this schema: once closed, a period row can never be updated
-- back to OPEN or have its dates changed.
CREATE RULE accounting_period_no_reopen AS ON UPDATE TO accounting_period
  WHERE OLD.status = 'CLOSED'
  DO INSTEAD NOTHING;

-- §13.6 step 4: agency sign-off per period.
CREATE TABLE period_agency_signoff (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id     UUID NOT NULL REFERENCES accounting_period(id),
  agency_id     UUID NOT NULL REFERENCES agency(id),
  signed_off_by VARCHAR(80) NOT NULL,
  signed_off_at TIMESTAMPTZ NOT NULL,
  ip_address    VARCHAR(45),
  UNIQUE (period_id, agency_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON settlement_cycle TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scroll TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scroll_line TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE ON accounting_period TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON period_agency_signoff TO nexuscollect_app;
