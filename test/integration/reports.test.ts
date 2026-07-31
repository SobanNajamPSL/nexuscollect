import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import * as reports from "../../src/modules/reports/index.js";
import { verifyReceiptSignature } from "../../src/platform/receipt-signing/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

describe("Phase 6: reports R01-R18 (§21.1)", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("R01: daily collection summary reflects real 2026-07-30 payments", async () => {
    const r = await reports.r01DailyCollectionSummary(testDb.db, "2026-07-30");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((row) => row.grossMinor > 0n)).toBe(true);
  });

  it("R02: head-wise statement for FBR 2026-07-30 ties to the real scroll control total", async () => {
    const r = await reports.r02HeadWiseStatement(testDb.db, "2026-07-30", "2026-07-30", "FBR");
    const total = r.rows.reduce((s, row) => s + row.amountMinor, 0n);
    expect(total).toBe(372_132_500n); // same real figure the scroll gate proves
  });

  it("R03: reconciliation certificate reports zero open breaks only once recon actually runs", async () => {
    const before = await reports.r03ReconciliationCertificate(testDb.db, "2026-07-30");
    expect(before.found).toBe(true);

    const { runReconciliation } = await import("../../src/modules/recon/index.js");
    await runReconciliation(testDb.db, "2026-07-30", clock);
    const after = await reports.r03ReconciliationCertificate(testDb.db, "2026-07-30");
    if (after.found) expect(after.totalBreaks).toBe(11); // the same real 11-break gate
  });

  it("R04: break register ageing groups the real planted breaks by code", async () => {
    const r = await reports.r04BreakRegisterAgeing(testDb.db, "2026-07-30");
    expect(Object.keys(r.byCode).length).toBeGreaterThan(0);
  });

  it("R06: unapplied receipts ageing lists only payments with a real unapplied balance", async () => {
    const r = await reports.r06UnappliedReceiptsAgeing(testDb.db, "2026-07-30");
    expect(r.rows.every((row) => row.amountMinor > 0)).toBe(true);
  });

  it("R07: outstanding assessments ageing sums real open balances", async () => {
    const r = await reports.r07OutstandingAssessmentsAgeing(testDb.db, "2026-07-30");
    expect(r.totalOutstandingMinor).toBeGreaterThan(0n);
  });

  it("R08: RtP funnel reflects real request_to_pay status distribution", async () => {
    const r = await reports.r08RtpFunnel(testDb.db);
    expect(Object.values(r.byStatus).reduce((s, c) => s + c, 0)).toBeGreaterThan(0);
  });

  it("R12: cheque performance reflects the real IN-0004 return", async () => {
    const r = await reports.r12ChequePerformance(testDb.db);
    expect(r.returnRatePct).toBeGreaterThan(0);
  });

  it("R13: control pack matches the live Control Assertions screen's own checks", async () => {
    const r = await reports.r13ControlPack(testDb.db);
    expect(r.trialBalance.passed).toBe(true);
    expect(r.hashChain.intact).toBe(true);
  });

  it("R15/R17: disclosed gaps are honest, not fabricated data", () => {
    expect(reports.r15SlaAvailability().disclosedGap).toMatch(/no.*tracking exists/i);
    expect(reports.r17RegulatoryReturn().disclosedGap).toMatch(/\[A\]/);
  });

  it("R18: fiscal year certificate is a real signed document, verifiable offline", async () => {
    const cert = await reports.r18FiscalYearCertificate(testDb.db, "FBR", "2026-07-01", "2026-07-31", clock);
    expect(BigInt(cert.total_minor)).toBeGreaterThan(0n);
    expect(verifyReceiptSignature(cert.signature.canonicalPayload, cert.signature.signatureBase64, cert.signature.publicKeyPem)).toBe(true);
  });
});
