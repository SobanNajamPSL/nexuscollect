import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import type { Kysely } from "kysely";
import { createDb, createPool } from "../../src/db/client.js";
import type { Database } from "../../src/db/schema.js";
import { runMigrations } from "../../scripts/migrate.js";

export interface TestDb {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  /** Connects as the migration/owner role — bypasses RLS (Postgres exempts table
   * owners by default). Use for fixture setup, not for RLS-sensitive assertions. */
  db: Kysely<Database>;
  /** Connects as `nexuscollect_app` (db/migrations/0015_app_role.sql) — a real
   * non-owner role, so RLS policies actually apply. Use this for anything that's
   * supposed to be tenant-scoped. */
  appDb: Kysely<Database>;
  stop: () => Promise<void>;
}

/** Starts a fresh Postgres 16 container and applies every migration to it. */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const connectionString = container.getConnectionUri();

  const migrateClient = new pg.Client({ connectionString });
  await migrateClient.connect();
  try {
    await runMigrations(migrateClient);
  } finally {
    await migrateClient.end();
  }

  const pool = createPool(connectionString);
  const db = createDb(pool);

  const appConnectionString = `postgres://nexuscollect_app:nexuscollect_app_demo_password@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  const appPool = createPool(appConnectionString);
  const appDb = createDb(appPool);

  return {
    container,
    pool,
    db,
    appDb,
    stop: async () => {
      await db.destroy();
      await appDb.destroy();
      await container.stop();
    },
  };
}
