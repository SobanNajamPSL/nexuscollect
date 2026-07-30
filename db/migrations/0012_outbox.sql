-- P2G-Collection-Platform-Design.md §23 "OUTBOX"
CREATE TABLE outbox_event (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID NOT NULL UNIQUE,
  aggregate_type VARCHAR(40) NOT NULL,
  aggregate_id   UUID NOT NULL,
  sequence       INTEGER NOT NULL,
  event_type     VARCHAR(60) NOT NULL,
  payload        JSONB NOT NULL,
  correlation_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ
);
CREATE INDEX ix_outbox_unpublished ON outbox_event (id) WHERE published_at IS NULL;
