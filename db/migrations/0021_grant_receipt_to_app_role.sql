-- Real bug found while testing finding P's new RLS policies: `receipt`
-- (migration 0016) was created AFTER 0015's
-- `GRANT ... ON ALL TABLES IN SCHEMA public`, which only applies to tables
-- that already existed at the moment it ran — not retroactively to tables
-- created later. `nexuscollect_app` has therefore never been able to read or
-- write `receipt` at all (a bare `permission denied`, not an RLS denial).
-- receipt's own RLS policy (migration 0016) has been silently unreachable
-- through the app role ever since. Grant it explicitly, the same way 0015 did
-- for everything that existed at the time.
GRANT SELECT, INSERT, UPDATE, DELETE ON receipt TO nexuscollect_app;
