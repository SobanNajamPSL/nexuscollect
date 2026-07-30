-- P2G-Collection-Platform-Design.md §23.1: "Repeat for every tenant-scoped table.
-- Set app.current_agency_id per request from the validated token, never from a
-- request parameter."
--
-- Applied to every table with a direct agency_id column. Two categories are
-- deliberately NOT scoped here, since neither has a direct agency_id column and
-- correct scoping would require a join-based policy (USING against a subquery)
-- rather than the spec's own direct-column pattern — left for a later phase to
-- revisit once the query patterns that would drive that join are known:
--   - assessment_line_item, payment_allocation, instrument_link (scope follows
--     their parent assessment/instrument)
--   - payer (shared across agencies via payer_account; no owning agency_id at all)
--
-- For tables where agency_id is nullable (a NULL agency_id row is a platform-wide
-- or cross-agency record — e.g. a reference_scheme with no owning agency, a
-- journal_entry not yet attributed), the predicate treats NULL as visible only to
-- the platform role, never to a tenant.

-- `current_setting('app.current_agency_id', true)` returns '' (not NULL) for a
-- session that never set it at all, and casting '' to uuid raises a hard error —
-- which happens per-row during policy evaluation regardless of whether the
-- platform-role half of the OR would otherwise have made the row visible. This
-- helper makes "no agency in session" resolve to a plain NULL uuid so an
-- `agency_id = ...` comparison just evaluates to NULL (i.e. false), never throws.
CREATE OR REPLACE FUNCTION _p2g_current_agency_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_agency_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- --- NOT NULL agency_id tables: plain equality check ---
ALTER TABLE revenue_head ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_revenue_head_tenant ON revenue_head
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE collection_product ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_collection_product_tenant ON collection_product
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE payer_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_payer_account_tenant ON payer_account
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE assessment ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_assessment_tenant ON assessment
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE resolution_index ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_resolution_index_tenant ON resolution_index
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE request_to_pay ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_request_to_pay_tenant ON request_to_pay
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

-- --- Nullable agency_id tables: NULL is platform-only, never a tenant match ---
-- (agency_id = _p2g_current_agency_id() already evaluates to NULL/false when
-- agency_id IS NULL, so no extra "agency_id IS NOT NULL" guard is needed.)
ALTER TABLE reference_scheme ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_reference_scheme_tenant ON reference_scheme
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_payment_tenant ON payment
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE instrument ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_instrument_tenant ON instrument
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE ledger_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_ledger_account_tenant ON ledger_account
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE journal_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_journal_entry_tenant ON journal_entry
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE recon_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_recon_run_tenant ON recon_run
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());

ALTER TABLE recon_break ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_recon_break_tenant ON recon_break
  USING (current_setting('app.is_platform_role', true) = 'true'
         OR agency_id = _p2g_current_agency_id());
