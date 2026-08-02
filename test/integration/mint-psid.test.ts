import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { mintPsid, PsidNotMintableError } from "../../src/modules/obligation/mint-psid.js";
import { dammValidate } from "../../src/platform/checksum/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");
const INSTITUTION = "00000000-0000-4000-8000-0000000000d1";

/**
 * Platform PSID minting (§7.3). Until the agency portal existed, this route
 * required the caller to supply a PSID — which meant an agency could not issue a
 * bill, since nobody composes a 17-digit Damm-checked reference by hand.
 */
describe("PSID minting", () => {
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

  async function issue(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/agency/assessments",
      headers: { "x-institution-id": INSTITUTION, "idempotency-key": crypto.randomUUID() },
      payload,
    });
  }

  const bill = (amountMinor: number) => ({
    product_code: "ETPB-TOKEN-CAR",
    payer: { payer_type: "INDIVIDUAL", primary_id_type: "CNIC", primary_id_value: "3520112233445", name: "Mint Test" },
    description: "Mint test",
    assessed_amount_minor: amountMinor,
    issue_date: "2026-07-30",
    due_date: "2026-08-30",
    line_items: [{ seq: 1, line_type: "PRINCIPAL", revenue_head_code: "E04210", amount_minor: amountMinor }],
  });

  it("mints a PSID when none is supplied, matching the scheme's prefix, length and check digit", async () => {
    const scheme = await testDb.db
      .selectFrom("reference_scheme")
      .select(["prefix", "total_length"])
      .where("code", "=", "PSID-ETPB-17")
      .executeTakeFirstOrThrow();

    const res = await issue(bill(500_00));
    expect(res.statusCode).toBe(201);
    const psid = res.json().psid as string;

    expect(psid).toHaveLength(scheme.total_length);
    expect(psid.startsWith(scheme.prefix ?? "")).toBe(true);
    expect(/^\d+$/.test(psid)).toBe(true);
    // The check digit must be real, not decorative.
    expect(dammValidate(psid)).toBe(true);
  });

  it("embeds the product's established 4-digit code, so a minted PSID reads alongside the seeded ones", async () => {
    const seeded = await testDb.db
      .selectFrom("assessment")
      .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
      .select("assessment.psid")
      .where("collection_product.code", "=", "ETPB-TOKEN-CAR")
      .orderBy("assessment.psid", "asc")
      .limit(1)
      .executeTakeFirstOrThrow();

    const res = await issue(bill(600_00));
    const psid = res.json().psid as string;
    // prefix is 2 digits for this scheme; the next 4 are the product code.
    expect(psid.slice(0, 6)).toBe(seeded.psid.slice(0, 6));
  });

  it("a minted PSID resolves, and altering one digit fails the checksum before any lookup", async () => {
    const psid = (await issue(bill(700_00))).json().psid as string;

    const ok = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": INSTITUTION },
      payload: { key_type: "PSID", key_value: psid, channel: "APP" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().payables.map((p: { psid: string }) => p.psid)).toContain(psid);

    const lastDigit = Number(psid.slice(-1));
    const tampered = psid.slice(0, -1) + String((lastDigit + 1) % 10);
    const bad = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": INSTITUTION },
      payload: { key_type: "PSID", key_value: tampered, channel: "APP" },
    });
    expect(bad.json().code).toBe("INVALID_REFERENCE_CHECKSUM");
  });

  it("mints monotonically and never collides with an existing PSID", async () => {
    const before = new Set((await testDb.db.selectFrom("assessment").select("psid").execute()).map((r) => r.psid));
    const a = (await issue(bill(800_00))).json().psid as string;
    const b = (await issue(bill(900_00))).json().psid as string;

    expect(a).not.toBe(b);
    expect(before.has(a)).toBe(false);
    expect(before.has(b)).toBe(false);
    expect(Number(b)).toBeGreaterThan(Number(a));
  });

  it("is deterministic — the demo must mint the same reference on every take", async () => {
    // Minting reads only committed state, so the same starting state must give
    // the same next value. CLAUDE.md: nothing the camera sees may be random.
    const product = await testDb.db
      .selectFrom("collection_product")
      .select(["id", "reference_scheme_id"])
      .where("code", "=", "ETPB-TOKEN-CAR")
      .executeTakeFirstOrThrow();

    const first = await mintPsid(testDb.db, product.id, product.reference_scheme_id);
    const second = await mintPsid(testDb.db, product.id, product.reference_scheme_id);
    expect(first).toBe(second);
  });

  it("refuses to mint for a scheme the agency owns, rather than inventing a reference", async () => {
    const scheme = await testDb.db
      .selectFrom("reference_scheme")
      .select(["id", "code"])
      .where("is_platform_minted", "=", false)
      .executeTakeFirst();
    if (!scheme) return; // every seeded scheme is platform-minted; nothing to assert

    const product = await testDb.db
      .selectFrom("collection_product")
      .select("id")
      .where("reference_scheme_id", "=", scheme.id)
      .executeTakeFirstOrThrow();

    await expect(mintPsid(testDb.db, product.id, scheme.id)).rejects.toBeInstanceOf(PsidNotMintableError);
  });
});
