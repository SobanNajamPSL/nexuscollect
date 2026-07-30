-- Finding P (audit): 0013_row_level_security.sql deliberately left
-- assessment_line_item, payment_allocation, and instrument_link unprotected —
-- documented at the time as "left for a later phase," which is now. None of
-- these three has a direct agency_id column, so each policy is a join back to
-- its parent's agency_id instead. The EXISTS subquery runs under the same
-- session context as the outer query, so it's itself subject to the parent
-- table's own RLS policy — consistent, not a bypass.
ALTER TABLE assessment_line_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_assessment_line_item_tenant ON assessment_line_item
  USING (
    current_setting('app.is_platform_role', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM assessment a
      WHERE a.id = assessment_line_item.assessment_id
        AND a.agency_id = _p2g_current_agency_id()
    )
  );

ALTER TABLE payment_allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_payment_allocation_tenant ON payment_allocation
  USING (
    current_setting('app.is_platform_role', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM assessment a
      WHERE a.id = payment_allocation.assessment_id
        AND a.agency_id = _p2g_current_agency_id()
    )
  );

ALTER TABLE instrument_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_instrument_link_tenant ON instrument_link
  USING (
    current_setting('app.is_platform_role', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM instrument i
      WHERE i.id = instrument_link.instrument_id
        AND i.agency_id = _p2g_current_agency_id()
    )
  );

-- Grant statements from 0015_app_role.sql already cover these tables
-- (GRANT ... ON ALL TABLES IN SCHEMA public), so nexuscollect_app can already
-- read/write them subject to the policies just added — no GRANT changes needed.
