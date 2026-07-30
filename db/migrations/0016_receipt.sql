-- §16.1's receipting system is Phase 5 in the spec's own §25 Build Plan, not
-- Phase 1 — but Prompt 1 explicitly requires resolve's ALREADY_SETTLED path to
-- return "the existing receipt," and the ResolveResponse schema requires a
-- `receipt_no`. This is the minimal slice pulled forward: just enough to mint
-- a gapless, real receipt number for an assessment that's genuinely already
-- paid (per its own payment_allocation rows). Signing, PDF/A-3, bilingual
-- rendering, and offline verification are the real §16 deliverables and stay
-- deferred to Phase 5.
CREATE TABLE receipt (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no   VARCHAR(40) NOT NULL UNIQUE, -- §16.1: {AGENCY}{YYYYMMDD}{9-digit seq}
  agency_id    UUID NOT NULL REFERENCES agency(id),
  payment_id   UUID NOT NULL REFERENCES payment(id),
  business_date DATE NOT NULL,              -- the date component baked into receipt_no
  status       TEXT NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'VOIDED', 'REFUNDED')),
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id) -- one receipt per payment in this minimal slice
);
CREATE INDEX ix_receipt_agency_date ON receipt (agency_id, business_date);

ALTER TABLE receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_receipt_tenant ON receipt
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());
