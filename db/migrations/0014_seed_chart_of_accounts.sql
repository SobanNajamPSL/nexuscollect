-- Platform chart of accounts, §10.3. This is normative reference data (like the
-- schema itself), not demo transactional data, so it ships as a migration rather
-- than through the demo-data loader.
--
-- Only the platform-wide, singular accounts are seeded here. Codes whose §10.3
-- name carries a "{branch}"/"{bank}"/"{rail}"/"{agent}"/"{agency}" placeholder
-- (1010, 1020, 1030, 1100, 1150, 1200, 1300, 2010, 2015, 2030, 2040) are
-- per-dimension accounts instantiated on demand once the code that drives that
-- dimension exists (e.g. a `2010-{agency}` Agency Payable row per agency, once
-- Phase 2's apply pipeline is posting entries against it) — out of scope for
-- Phase 0, which has no ledger-posting business logic yet.
INSERT INTO ledger_account (code, name, account_type, normal_balance, agency_id) VALUES
  ('1900', 'Suspense — Recon Investigation', 'ASSET',     'DR', NULL),
  ('2020', 'Unapplied Receipts',             'LIABILITY', 'CR', NULL),
  ('2050', 'Refunds Payable',                'LIABILITY', 'CR', NULL),
  ('2060', 'Unclaimed Funds',                'LIABILITY', 'CR', NULL),
  ('2100', 'Fee Payable to Channel Partner', 'LIABILITY', 'CR', NULL),
  ('2200', 'Tax on Fees Payable',            'LIABILITY', 'CR', NULL),
  ('4010', 'Platform Fee Income',            'INCOME',    'CR', NULL),
  ('4020', 'Dishonour Charge Income',        'INCOME',    'CR', NULL),
  ('5010', 'Rail/Scheme Cost',               'EXPENSE',   'DR', NULL),
  ('5020', 'Channel Commission Expense',     'EXPENSE',   'DR', NULL),
  ('5900', 'Cash Over/Short',                'EXPENSE',   'DR', NULL),
  ('5910', 'Recon Write-off',                'EXPENSE',   'DR', NULL),
  -- §10.3: Equity, "should never carry a balance. Alarm if non-zero." Equity
  -- accounts have no normal_balance in the spec's own table ("—"); modelled here
  -- as CR since that keeps it on the credit side of the fundamental accounting
  -- equation like every other equity account, and it's expected to net to zero.
  ('3900', 'Control — Unbalanced Detected',  'EQUITY',    'CR', NULL);
