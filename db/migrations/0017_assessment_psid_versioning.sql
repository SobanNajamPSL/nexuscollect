-- §23's DDL declares `psid VARCHAR(30) NOT NULL UNIQUE` (one row per PSID) —
-- but §9.1 amendment is explicit: "Create version v+1, keep the SAME PSID,
-- mark v as AMENDED." Multiple assessment rows sharing one PSID is the whole
-- point of amendment (found by a real test failure: amendAssessment inserting
-- a v2 row hit "duplicate key value violates unique constraint
-- assessment_psid_key"). A PSID identifies a demand across its version
-- history; only one version of it is ever the current/open one at a time,
-- which resolution_index's `is_open` flag already tracks correctly. The
-- uniqueness that actually holds is (psid, version).
ALTER TABLE assessment DROP CONSTRAINT assessment_psid_key;
ALTER TABLE assessment ADD CONSTRAINT assessment_psid_version_key UNIQUE (psid, version);
