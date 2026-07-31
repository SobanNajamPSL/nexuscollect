-- §8.6's Bill Payment Reversal (message 3 of 4) "MUST be safe against a
-- reversal without an original — a frequent condition when the original Bill
-- Payment timed out on the switch side." No existing table can hold that
-- half-formed reversal while it waits for the late original to arrive, so
-- this is new, minimal, storage-only state (the actual pairing/reversal logic
-- lives in src/adapters/switch).
CREATE TABLE switch_pending_reversal (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acquirer_id               VARCHAR(20) NOT NULL,
  original_stan             VARCHAR(12) NOT NULL,
  original_rrn              VARCHAR(20) NOT NULL,
  txn_date                  DATE NOT NULL,
  transaction_amount_minor  BIGINT,
  reversal_reason           TEXT NOT NULL CHECK (reversal_reason IN
                              ('TIMEOUT','CUSTOMER_CANCELLED','TECHNICAL','DUPLICATE','LATE_RESPONSE')),
  status                    TEXT NOT NULL DEFAULT 'PENDING_ORIGINAL' CHECK (status IN
                              ('PENDING_ORIGINAL','PAIRED_AND_REVERSED','NOT_REVERSIBLE')),
  resolved_payment_id       UUID REFERENCES payment(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at               TIMESTAMPTZ
);
CREATE UNIQUE INDEX ux_switch_pending_reversal ON switch_pending_reversal (acquirer_id, original_stan, original_rrn, txn_date)
  WHERE status = 'PENDING_ORIGINAL';

GRANT SELECT, INSERT, UPDATE, DELETE ON switch_pending_reversal TO nexuscollect_app;
