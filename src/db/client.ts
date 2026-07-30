import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

// node-postgres returns BIGINT (oid 20) and BIGSERIAL as strings by default, which
// would make it trivially easy to accidentally round-trip money through `Number()`
// somewhere. CLAUDE.md hard rule #1 is "money is bigint, never number, anywhere" —
// so every int8 column comes back as a native bigint instead.
pg.types.setTypeParser(20, (value: string) => BigInt(value));

// node-postgres's default parser for DATE (oid 1082) returns a JS `Date`
// (midnight local-ish), which is wrong for a pure calendar date — CLAUDE.md's
// two-sided-time rule treats `value_date`-style columns as Asia/Karachi
// business dates, not instants, and the schema types every DATE column as a
// plain `YYYY-MM-DD` string (Dated in db/schema.ts). Keep it a string.
pg.types.setTypeParser(1082, (value: string) => value);

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * Row-level security (§23.1) reads `app.current_agency_id` / `app.is_platform_role`
 * from the session. These must be set per-request from the validated auth token,
 * never from a request parameter, and must not leak between requests — so they are
 * always set with SET LOCAL inside the same transaction the caller's queries run in.
 */
export async function withAgencyContext<T>(
  db: Kysely<Database>,
  context: { agencyId?: string; isPlatformRole?: boolean },
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    if (context.agencyId) {
      await sql`SELECT set_config('app.current_agency_id', ${context.agencyId}, true)`.execute(trx);
    }
    await sql`SELECT set_config('app.is_platform_role', ${context.isPlatformRole ? "true" : "false"}, true)`.execute(
      trx,
    );
    return fn(trx);
  });
}

let defaultPool: pg.Pool | undefined;
let defaultDb: Kysely<Database> | undefined;

/** Lazily-constructed singleton for app runtime (api/index.ts, scripts/*). */
export function getDb(): Kysely<Database> {
  if (!defaultDb) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    defaultPool = createPool(connectionString);
    defaultDb = createDb(defaultPool);
  }
  return defaultDb;
}

export async function closeDb(): Promise<void> {
  if (defaultDb) {
    await defaultDb.destroy();
    defaultDb = undefined;
    defaultPool = undefined;
  }
}
