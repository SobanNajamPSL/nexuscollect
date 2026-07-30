-- P2G-Collection-Platform-Design.md §23 "IDEMPOTENCY", semantics per §17.4
CREATE TABLE idempotency_record (
  institution_id   UUID NOT NULL,
  endpoint         VARCHAR(120) NOT NULL,
  idempotency_key  VARCHAR(64) NOT NULL,
  request_fingerprint BYTEA NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETE')),
  response_status  SMALLINT,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  PRIMARY KEY (institution_id, endpoint, idempotency_key)   -- this IS the lock
);
