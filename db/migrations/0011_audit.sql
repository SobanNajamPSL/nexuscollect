-- P2G-Collection-Platform-Design.md §23 "AUDIT (hash-chained)"
CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('USER','SERVICE','SYSTEM','INSTITUTION')),
  actor_id       VARCHAR(80) NOT NULL,
  action         VARCHAR(60) NOT NULL,
  entity_type    VARCHAR(40) NOT NULL,
  entity_id      VARCHAR(80),
  before_json    JSONB,
  after_json     JSONB,
  ip             INET,
  user_agent     VARCHAR(300),
  correlation_id UUID,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  hash_prev      BYTEA,
  hash_self      BYTEA NOT NULL
);
CREATE RULE audit_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
