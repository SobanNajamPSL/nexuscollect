import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * Finding C (audit): all 17 `ResolutionKeyType` enum values from
 * api/openapi.yaml must resolve for real, against real demo-data fixture
 * values wherever they exist — not a hard-coded closed list, not a
 * "NOT_CONFIGURED" placeholder. Every value below was confirmed present in
 * demo-data/assessments.csv's `metadata` column (or payers.csv/payer_accounts.csv
 * for the identity/CRN/RAAST_ID types) before writing this test — see the
 * grep evidence in the audit-remediation plan.
 *
 * Two of the 17 (DL_NO, STRN) have zero real fixture data anywhere in
 * demo-data/ (confirmed: no assessment metadata carries `dl_no`, no payer has
 * `primary_id_type = STRN`) — a genuine data gap, not a code gap. Per the
 * precedent already established for DL_NO, this gets a synthetic row inserted
 * directly into the test database (the same way rls.test.ts builds its own
 * fixtures), never a demo-data edit, with the gap reported explicitly rather
 * than hidden.
 */
describe("Phase 1 finding C: all 17 resolution key types", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  async function resolve(keyType: string, keyValue: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": "bank-test-001" },
      payload: { key_type: keyType, key_value: keyValue, channel: "APP", ...extra },
    });
  }

  const GENERIC_INDEX_CASES: { keyType: string; keyValue: string; expectedPsid: string }[] = [
    { keyType: "VEHICLE_REG", keyValue: "LEA-17-1000", expectedPsid: "31010900000181526" },
    { keyType: "PROPERTY_ID", keyValue: "MT-1200", expectedPsid: "31011200002288756" },
    { keyType: "CHASSIS_NO", keyValue: "NZE121045000", expectedPsid: "31011000002865112" },
    { keyType: "CASE_NO", keyValue: "CP-1123/2026", expectedPsid: "61011600000162876" },
    { keyType: "APPLICATION_NO", keyValue: "NAD-2026-8891200", expectedPsid: "88000000000013" },
    { keyType: "GD_NO", keyValue: "KAPW-HC-60100", expectedPsid: "12010500002672566" },
    { keyType: "INSTRUMENT_NO", keyValue: "INS-2026-445000", expectedPsid: "71011800000183627" },
    { keyType: "TENDER_REF", keyValue: "BOR-T-2026-77", expectedPsid: "71011900000767480" },
    { keyType: "CRN", keyValue: "LEA-17-1000", expectedPsid: "31010900000181526" },
  ];

  it.each(GENERIC_INDEX_CASES)(
    "$keyType=$keyValue resolves to PSID $expectedPsid via the generic resolution_index lookup",
    async ({ keyType, keyValue, expectedPsid }) => {
      const response = await resolve(keyType, keyValue);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const psids = [...body.payables.map((p: { psid: string }) => p.psid), ...body.settled.map((s: { psid: string }) => s.psid)];
      expect(psids, `${keyType}=${keyValue}`).toContain(expectedPsid);
    },
  );

  it("VEHICLE_REG normalization: LEA-17-1000 and LEA171000 resolve identically (finding J)", async () => {
    const withHyphens = await resolve("VEHICLE_REG", "LEA-17-1000");
    const withoutHyphens = await resolve("VEHICLE_REG", "LEA171000");
    expect(withoutHyphens.statusCode).toBe(200);
    const a = withHyphens.json();
    const b = withoutHyphens.json();
    expect(b.payables.map((p: { psid: string }) => p.psid).sort()).toEqual(a.payables.map((p: { psid: string }) => p.psid).sort());
  });

  it("RAAST_ID resolves via the payer-wide identity path (with step-up)", async () => {
    const response = await resolve("RAAST_ID", "+923001000000", { identity_assertion: { asserted_by_institution: true } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const psids = [...body.payables.map((p: { psid: string }) => p.psid), ...body.settled.map((s: { psid: string }) => s.psid)];
    expect(psids).toContain("12010600005120245"); // AS-00164, ISSUED, PY-C001
  });

  it("RAAST_ID without step-up is rejected (§20.6)", async () => {
    const response = await resolve("RAAST_ID", "+923001000000");
    expect(response.statusCode).toBe(401);
  });

  it("CNIC resolves via the payer-wide identity path using the exact loaded format", async () => {
    // hashPrimaryId hashes the raw string verbatim (no normalization) — the
    // loader hashed "35202-2000000-1" exactly as it appears in payers.csv.
    const response = await resolve("CNIC", "35202-2000000-1", { identity_assertion: { asserted_by_institution: true } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.payables.length + body.settled.length).toBeGreaterThan(0);
  });

  it("NTN resolves via the payer-wide identity path (no step-up required)", async () => {
    const response = await resolve("NTN", "1000000-1");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const psids = [...body.payables.map((p: { psid: string }) => p.psid), ...body.settled.map((s: { psid: string }) => s.psid)];
    expect(psids).toContain("12010600005120245"); // same payer (PY-C001) as the RAAST_ID case
  });

  it("QR_PAYLOAD: dynamic QR with an embedded amount resolves to its PSID (demo-data/qr-payloads.json)", async () => {
    const payload =
      "00020101021226340008PK.RAAST0112NEXUSCOLLECT02024152049311530358654073750.005802PK5923PUNJAB SAFE CITIES AUTH6006LAHORE62530117410113000001901230511CHL-07791230713AGENCY-CTR-016304866B";
    const response = await resolve("QR_PAYLOAD", payload);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.payables.map((p: { psid: string }) => p.psid)).toContain("41011300000190123");
  });

  it("QR_PAYLOAD: static counter QR (no bill number) resolves to an empty, non-error result", async () => {
    const payload =
      "00020101021126340008PK.RAAST0112NEXUSCOLLECT0202005204931153035865802PK5917LAHORE HIGH COURT6006LAHORE62170713AGENCY-CTR-016304D2BF";
    const response = await resolve("QR_PAYLOAD", payload);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.payables).toHaveLength(0);
    expect(body.settled).toHaveLength(0);
  });

  it("QR_PAYLOAD: corrupted CRC is rejected with QR_CRC_INVALID, not a silent empty result", async () => {
    const payload =
      "00020101021226340008PK.RAAST0112NEXUSCOLLECT02024152049311530358654073750.005802PK5923PUNJAB SAFE CITIES AUTH6006LAHORE62530117410113000001901230511CHL-07791230713AGENCY-CTR-0163048694";
    const response = await resolve("QR_PAYLOAD", payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("QR_CRC_INVALID");
  });

  describe("DL_NO and STRN: no real fixture data exists anywhere in demo-data/ (confirmed by exhaustive grep)", () => {
    it("DL_NO resolves via a synthetic test-database row, proving the generic mechanism (not the data) is what's missing", async () => {
      // PSCA-CHALLAN-MOV declares DL_NO as a valid secondary_lookup_keys entry
      // (products.csv) but no assessment in the pack carries a dl_no metadata
      // value. Insert one directly against the already-loaded schema, exactly
      // as rls.test.ts builds its own fixtures — never a demo-data edit.
      const product = await testDb.db.selectFrom("collection_product").selectAll().where("code", "=", "PSCA-CHALLAN-MOV").executeTakeFirstOrThrow();
      const agency = await testDb.db.selectFrom("agency").selectAll().where("id", "=", product.agency_id).executeTakeFirstOrThrow();
      const revenueHead = await testDb.db
        .selectFrom("revenue_head")
        .selectAll()
        .where("id", "=", product.default_revenue_head_id)
        .executeTakeFirstOrThrow();

      const inserted = await testDb.db
        .insertInto("assessment")
        .values({
          psid: "41019900099999901",
          agency_id: agency.id,
          product_id: product.id,
          payer_snapshot: sql`'{}'::jsonb`,
          description: "Synthetic test-only assessment for DL_NO coverage (finding C data-gap)",
          assessed_amount_minor: 100000n,
          payable_amount_minor: 100000n,
          balance_minor: 100000n,
          issue_date: "2026-07-01",
          due_date: "2026-08-01",
          status: "ISSUED",
          source: "TEST_SYNTHETIC",
          metadata: sql`'{"dl_no": "DL-TEST-000001"}'::jsonb`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await testDb.db
        .insertInto("assessment_line_item")
        .values({
          assessment_id: inserted.id,
          seq: 1,
          line_type: "PRINCIPAL",
          revenue_head_id: revenueHead.id,
          amount_minor: 100000n,
        })
        .execute();

      const response = await resolve("DL_NO", "DL-TEST-000001");
      expect(response.statusCode).toBe(200);
      expect(response.json().payables.map((p: { psid: string }) => p.psid)).toContain("41019900099999901");
    });

    it("STRN resolves via a synthetic test-database payer, proving the generic identity mechanism (not the data) is what's missing", async () => {
      const { hashPrimaryId, encryptPrimaryId } = await import("../../src/modules/identity/pii.js");
      const product = await testDb.db.selectFrom("collection_product").selectAll().where("code", "=", "FBR-IT-COMP").executeTakeFirstOrThrow();

      const payer = await testDb.db
        .insertInto("payer")
        .values({
          payer_type: "COMPANY",
          primary_id_type: "STRN",
          primary_id_hash: hashPrimaryId("STRN", "STRN-TEST-000001"),
          primary_id_enc: encryptPrimaryId("STRN-TEST-000001"),
          primary_id_last4: "0001",
          name: "Synthetic STRN Test Payer",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const revenueHead = await testDb.db
        .selectFrom("revenue_head")
        .selectAll()
        .where("id", "=", product.default_revenue_head_id)
        .executeTakeFirstOrThrow();

      const inserted = await testDb.db
        .insertInto("assessment")
        .values({
          psid: "41019900099999902",
          agency_id: product.agency_id,
          product_id: product.id,
          payer_id: payer.id,
          payer_snapshot: sql`'{}'::jsonb`,
          description: "Synthetic test-only assessment for STRN coverage (finding C data-gap)",
          assessed_amount_minor: 100000n,
          payable_amount_minor: 100000n,
          balance_minor: 100000n,
          issue_date: "2026-07-01",
          due_date: "2026-08-01",
          status: "ISSUED",
          source: "TEST_SYNTHETIC",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await testDb.db
        .insertInto("assessment_line_item")
        .values({
          assessment_id: inserted.id,
          seq: 1,
          line_type: "PRINCIPAL",
          revenue_head_id: revenueHead.id,
          amount_minor: 100000n,
        })
        .execute();

      const response = await resolve("STRN", "STRN-TEST-000001", { identity_assertion: { asserted_by_institution: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json().payables.map((p: { psid: string }) => p.psid)).toContain("41019900099999902");
    });
  });
});
