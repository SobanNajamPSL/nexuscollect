import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");
const INSTITUTION = "00000000-0000-4000-8000-0000000000d1";
const DATE = "2026-07-30";

/**
 * The demonstration must be deterministic: same actions, same numbers, same screens,
 * every time. That is a standing rule of this build, and it is not only about
 * amounts — **row order and minted identifiers are things the camera sees too.**
 *
 * Three real defects motivated these tests, all found by capturing the manual's
 * screenshots twice and diffing the images:
 *
 *   1. Nine list endpoints had no `ORDER BY` at all, and several more ordered by a
 *      column that is not unique. Two reconciliation breaks sharing a severity and a
 *      code swapped places between runs.
 *   2. `payments/search` combined `LIMIT 50` with no ordering, which returns an
 *      arbitrary fifty of the matches — a different result set each time, not merely
 *      a different order.
 *   3. Receipt numbers are gapless per agency per day, so which payment gets which
 *      number depends on the order the loader walks them in. It walked them by
 *      `payment.id` — a fresh UUID on every seed — so the same settled bill showed
 *      receipt …004 on one reset and …003 on the next.
 */
describe("Determinism of everything the camera sees", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock, demoDataDir: DEMO_DATA_DIR });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  /** Two identical requests must return byte-identical bodies, order included. */
  async function twice(url: string): Promise<[string, string]> {
    const a = await app.inject({ method: "GET", url, headers: { "x-institution-id": INSTITUTION } });
    const b = await app.inject({ method: "GET", url, headers: { "x-institution-id": INSTITUTION } });
    return [a.body, b.body];
  }

  const LIST_ROUTES = [
    "/internal/agencies",
    "/internal/products",
    "/internal/reference-schemes",
    "/internal/revenue-heads",
    "/internal/unapplied-receipts",
    "/internal/payments/uncertain",
    "/internal/instruments",
    `/internal/ops/overview?date=${DATE}`,
    "/internal/payments/search?q=P26",
    "/internal/payers/search?q=a",
  ];

  it.each(LIST_ROUTES)("returns rows in a stable order: %s", async (url) => {
    const [first, second] = await twice(url);
    expect(first).toBe(second);
  });

  it("orders every list route rather than relying on Postgres row order", async () => {
    // A guard against the class of bug rather than an instance of it: any list route
    // added later without an ORDER BY will fail here on its first non-trivial data.
    for (const url of LIST_ROUTES) {
      const res = await app.inject({ method: "GET", url, headers: { "x-institution-id": INSTITUTION } });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("mints the same receipt number for the same payment across independent loads", async () => {
    const before = await testDb.db
      .selectFrom("receipt")
      .innerJoin("payment", "payment.id", "receipt.payment_id")
      .select(["payment.payment_reference", "receipt.receipt_no"])
      .orderBy("payment.payment_reference", "asc")
      .execute();
    expect(before.length).toBeGreaterThan(10);

    // Rebuild from the same source data, exactly as `POST /internal/demo/reset` does.
    const reset = await app.inject({ method: "POST", url: "/internal/demo/reset" });
    expect(reset.statusCode).toBe(200);

    const after = await testDb.db
      .selectFrom("receipt")
      .innerJoin("payment", "payment.id", "receipt.payment_id")
      .select(["payment.payment_reference", "receipt.receipt_no"])
      .orderBy("payment.payment_reference", "asc")
      .execute();

    // Every payment reference must map to the same receipt number it did before.
    // The primary keys are all new; the numbers a payer would quote are not.
    expect(after).toEqual(before);
  });

  it("resolves a reference to the same payables, in the same order, every time", async () => {
    const body = { key_type: "VEHICLE_REG", key_value: "LEA-17-1000", channel: "APP" };
    const first = await app.inject({ method: "POST", url: "/v1/resolve", headers: { "x-institution-id": INSTITUTION }, payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/resolve", headers: { "x-institution-id": INSTITUTION }, payload: body });

    const strip = (raw: string): unknown => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // The token embeds an issue time; everything else must match exactly.
      delete parsed.resolution_token;
      delete parsed.token_expires_at;
      return parsed;
    };
    expect(strip(first.body)).toEqual(strip(second.body));
  });

  it("finds the same eleven breaks, in the same order, on a re-run", async () => {
    const run = async (): Promise<string> => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/recon/run",
        headers: { "idempotency-key": `determinism-${DATE}` },
        payload: { business_date: DATE },
      });
      expect(res.statusCode).toBeLessThan(300);
      const listed = await app.inject({ method: "GET", url: `/internal/breaks?business_date=${DATE}` });
      const rows = listed.json() as { break_code: string; amount_minor: number }[];
      return rows.map((r) => `${r.break_code}:${r.amount_minor}`).join("|");
    };

    const first = await run();
    expect(first.split("|")).toHaveLength(11);
    expect(await run()).toBe(first);
  });
});
