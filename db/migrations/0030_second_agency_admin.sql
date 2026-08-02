-- Maker-checker on agency configuration needs two people who can both hold the
-- checker role, and migration 0028 seeded only one AGENCY_ADMIN. That left a
-- dead end: if the single administrator proposed a product, nobody was eligible
-- to approve it, because the database (correctly) refuses a self-approval.
--
-- §3.2 puts the agency administrator in the checker seat for its own agency's
-- configuration, and a real agency has more than one. Seeding a second makes the
-- control demonstrable from either persona instead of only one direction.
INSERT INTO platform_user (id, name, agency_id) VALUES
  ('00000000-0000-4000-9000-000000000011', 'Hina Jamil (Agency Admin, ETPB)',
   (SELECT id FROM agency WHERE code = 'ETPB'));

INSERT INTO user_role (user_id, role_code) VALUES
  ('00000000-0000-4000-9000-000000000011', 'AGENCY_ADMIN');
