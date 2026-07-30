-- P2G-Collection-Platform-Design.md §23 "MAKER-CHECKER"
CREATE TABLE approval (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   VARCHAR(40) NOT NULL,
  subject_id     UUID NOT NULL,
  action         VARCHAR(40) NOT NULL,
  amount_minor   BIGINT,
  payload        JSONB NOT NULL,
  maker_user_id  UUID NOT NULL,
  maker_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  checker_user_id UUID,
  checker_at     TIMESTAMPTZ,
  state          TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (state IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  comment        TEXT,
  CONSTRAINT ck_segregation CHECK (checker_user_id IS NULL OR checker_user_id <> maker_user_id)
);
