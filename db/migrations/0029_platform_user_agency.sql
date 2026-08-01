-- `platform_user.agency_id` has existed since migration 0027 but was never
-- populated — the two agency-staff demo users carried their agency only inside
-- their display name ("Bilal Farooq (Agency Admin, ETPB)"), which meant nothing
-- in the data could tell you which tenant an agency user belongs to.
--
-- The portal restructure makes that load-bearing: the agency portal scopes
-- everything to the acting user's own agency, so the persona has to actually
-- carry one. Real auth would populate this from the identity provider; here the
-- demo roster does, and the value is real rather than parsed out of a string.
UPDATE platform_user
SET agency_id = (SELECT id FROM agency WHERE code = 'ETPB')
WHERE id IN (
  '00000000-0000-4000-9000-000000000001',  -- Bilal Farooq, Agency Administrator
  '00000000-0000-4000-9000-000000000002'   -- Sana Malik, Agency Operator
);
