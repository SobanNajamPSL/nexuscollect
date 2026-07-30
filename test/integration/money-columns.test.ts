import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startTestDb, type TestDb } from "./helpers.js";

/**
 * PROMPTS.md Prompt 0, acceptance test 7: "No money column anywhere is
 * float/double/numeric/Decimal." Introspects the actual schema rather than
 * trusting the migration source — this is what a reviewer restoring the DB and
 * running `\d+` would actually see.
 */
describe("Schema: money is bigint everywhere, never float/double/numeric", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("every *_minor column is bigint", async () => {
    const { rows } = await sql<{ table_name: string; column_name: string; data_type: string }>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%\\_minor' ESCAPE '\\'
      ORDER BY table_name, column_name
    `.execute(testDb.db);

    expect(rows.length).toBeGreaterThan(0); // sanity: the query actually found money columns
    const notBigint = rows.filter((r) => r.data_type !== "bigint");
    expect(notBigint, JSON.stringify(notBigint, null, 2)).toEqual([]);
  });

  it("no float/double/decimal columns exist anywhere in the schema", async () => {
    const { rows } = await sql<{ table_name: string; column_name: string; data_type: string }>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('real', 'double precision')
    `.execute(testDb.db);
    expect(rows).toEqual([]);
  });

  it("the only NUMERIC columns are the two known percentage/rate fields, never money", async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'numeric'
      ORDER BY table_name, column_name
    `.execute(testDb.db);

    const allowed = new Set(["collection_product.min_partial_pct", "recon_run.auto_match_rate_pct"]);
    const actual = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    expect(actual).toEqual(allowed);
  });
});
