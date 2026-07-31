-- §18.2 webhook delivery contract, §16.3 notifications — Prompt 7.

CREATE TABLE webhook_subscription (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID REFERENCES agency(id),
  url                   VARCHAR(500) NOT NULL,
  secret_current         VARCHAR(100) NOT NULL,
  secret_previous        VARCHAR(100),
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §18.2's retry schedule (0s, 30s, 2m, 10m, 1h, 6h, 24h, then dead-letter) is
-- 7 attempts (0..6); `attempt_no` counts which one this row represents.
CREATE TABLE webhook_delivery (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id     UUID NOT NULL REFERENCES webhook_subscription(id),
  event_id            UUID NOT NULL,
  attempt_no          SMALLINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED','DEAD_LETTERED')),
  next_attempt_at     TIMESTAMPTZ NOT NULL,
  last_response_code  INTEGER,
  last_error          TEXT,
  delivered_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id)
);

-- §16.3 notifications.
CREATE TABLE notification_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id      UUID REFERENCES payer(id),
  assessment_id UUID REFERENCES assessment(id),
  event_type    VARCHAR(40) NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('SMS','EMAIL','PUSH','LETTER')),
  template_version VARCHAR(20) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','SUPPRESSED_QUIET_HOURS','SUPPRESSED_CAP_REACHED','FAILED')),
  suppressed_reason VARCHAR(60),
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_notification_log_payer_assessment ON notification_log (payer_id, assessment_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_subscription TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_delivery TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_log TO nexuscollect_app;
