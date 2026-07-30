-- §23.1's RLS policies only restrict non-owner roles — Postgres exempts the table
-- owner (and superusers) from row-level security by default. The migration
-- runner connects as the owner (it has to, to run DDL), so the application
-- itself must connect as a distinct, unprivileged role or RLS is silent theatre.
--
-- The password below is a fixed demo/local value, deliberately not read from an
-- environment variable here (a static .sql file can't do that) — CLAUDE.md's
-- "no HSM/key management this phase" applies here too. A real deployment must
-- create this role out-of-band with a secrets-managed password, not via this file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nexuscollect_app') THEN
    CREATE ROLE nexuscollect_app LOGIN PASSWORD 'nexuscollect_app_demo_password';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO nexuscollect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexuscollect_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexuscollect_app;
