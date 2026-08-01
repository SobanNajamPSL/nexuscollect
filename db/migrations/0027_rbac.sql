-- §3.2: internal roles (RBAC) — "seed these exactly." Until this migration,
-- there was no application-level role or permission concept anywhere in this
-- build — `nexuscollect_app` (migration 0015) is a Postgres *login* role for
-- row-level security, an entirely different thing. This adds a real,
-- lightweight role model: a fixed role catalogue, a minimal user record (this
-- build's auth is a deliberate header stub — see auth-stub.ts — so this is
-- not a full identity system), and the assignment between them.

CREATE TABLE role (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
);

INSERT INTO role (code, name, description) VALUES
  ('PLATFORM_ADMIN',      'Platform Administrator',   'Manages tenants, roles, config; cannot touch a financial record directly'),
  ('AGENCY_ADMIN',        'Agency Administrator',     'Configures own agency''s products, heads, users; checker for own config'),
  ('AGENCY_OPERATOR',     'Agency Operator',          'Creates/amends/cancels own agency''s assessments (maker)'),
  ('OPS_RECON_ANALYST',   'Reconciliation Analyst',   'Runs reconciliation, investigates breaks, proposes adjustments (maker)'),
  ('OPS_RECON_APPROVER',  'Reconciliation Approver',  'Approves/rejects adjustments and write-offs (checker; segregated from analyst)'),
  ('OPS_REFUND_MAKER',    'Refund Maker',             'Initiates refunds (maker)'),
  ('OPS_REFUND_APPROVER', 'Refund Approver',          'Approves refunds up to a limit, escalates above it (checker)'),
  ('TELLER',              'Teller',                   'Accepts OTC cash/cheque, prints receipts, reverses within same session (maker)'),
  ('BRANCH_SUPERVISOR',   'Branch Supervisor',        'Approves teller reversals, closes till (checker); cannot accept payments'),
  ('SUPPORT_AGENT',       'Support Agent',            'Reads payer/payment records, resends receipts; cannot see full CNIC/PAN or move money'),
  ('AUDITOR',             'Auditor',                  'Reads everything including the audit log, exports; cannot write anything'),
  ('SERVICE_CHANNEL',     'Service Channel',          'Calls resolution + payment APIs for its own institution only');

CREATE TABLE platform_user (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  agency_id  UUID REFERENCES agency(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_role (
  user_id   UUID NOT NULL REFERENCES platform_user(id),
  role_code TEXT NOT NULL REFERENCES role(code),
  PRIMARY KEY (user_id, role_code)
);
