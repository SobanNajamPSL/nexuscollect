-- §8.7/§8.10: agent / branchless banking channel. "An agent is not a branch"
-- — an agent collects cash from citizens against a pre-funded float held
-- with the operator, and periodically remits/reconciles that float. This is
-- genuinely new: AGENT was, until this migration, an unused enum literal
-- with no ledger or reconciliation concept behind it at all.

CREATE TABLE agent_float_account (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_code      VARCHAR(30) NOT NULL UNIQUE,
  agent_name      TEXT NOT NULL,
  institution_bic VARCHAR(11),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per collection (a debit against the float — the agent now owes
-- the operator this amount) or per remittance (a credit — the agent has
-- physically handed the cash/transfer back). The float's running position
-- for any business date is always derived (Σ debits − Σ credits), never
-- cached — same "balances are derived" discipline as the rest of the ledger.
CREATE TABLE agent_float_movement (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_float_account_id UUID NOT NULL REFERENCES agent_float_account(id),
  payment_id             UUID REFERENCES payment(id),
  movement_type          TEXT NOT NULL CHECK (movement_type IN ('COLLECTION','REMITTANCE')),
  amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
  business_date          DATE NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_agent_float_movement_account_date ON agent_float_movement (agent_float_account_id, business_date);
