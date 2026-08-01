-- A handful of named demo operational users, each holding exactly the role
-- their job title implies — real configuration data (like the roles and
-- agencies themselves), not a fabricated transactional figure. Fixed UUIDs
-- so the UI and API demos below can reference them by name deterministically.

INSERT INTO platform_user (id, name) VALUES
  ('00000000-0000-4000-9000-000000000001', 'Bilal Farooq (Agency Admin, ETPB)'),
  ('00000000-0000-4000-9000-000000000002', 'Sana Malik (Agency Operator, ETPB)'),
  ('00000000-0000-4000-9000-000000000003', 'Imran Qureshi (Recon Analyst)'),
  ('00000000-0000-4000-9000-000000000004', 'Ayesha Riaz (Recon Approver)'),
  ('00000000-0000-4000-9000-000000000005', 'Usman Tariq (Refund Maker)'),
  ('00000000-0000-4000-9000-000000000006', 'Farah Sheikh (Refund Approver)'),
  ('00000000-0000-4000-9000-000000000007', 'Nadia Aslam (Teller)'),
  ('00000000-0000-4000-9000-000000000008', 'Kamran Butt (Branch Supervisor)'),
  ('00000000-0000-4000-9000-000000000009', 'Zara Hussain (Support Agent)'),
  ('00000000-0000-4000-9000-000000000010', 'Tariq Mehmood (Auditor)');

INSERT INTO user_role (user_id, role_code) VALUES
  ('00000000-0000-4000-9000-000000000001', 'AGENCY_ADMIN'),
  ('00000000-0000-4000-9000-000000000002', 'AGENCY_OPERATOR'),
  ('00000000-0000-4000-9000-000000000003', 'OPS_RECON_ANALYST'),
  ('00000000-0000-4000-9000-000000000004', 'OPS_RECON_APPROVER'),
  ('00000000-0000-4000-9000-000000000005', 'OPS_REFUND_MAKER'),
  ('00000000-0000-4000-9000-000000000006', 'OPS_REFUND_APPROVER'),
  ('00000000-0000-4000-9000-000000000007', 'TELLER'),
  ('00000000-0000-4000-9000-000000000008', 'BRANCH_SUPERVISOR'),
  ('00000000-0000-4000-9000-000000000009', 'SUPPORT_AGENT'),
  ('00000000-0000-4000-9000-000000000010', 'AUDITOR');
