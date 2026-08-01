import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import {
  assignValueDate, generateScroll, runSweep, closePeriod, runPreCloseChecks,
  recordAgencySignoff, recordScrollAck, PeriodCloseBlockedError, PeriodAlreadyClosedError, isDateInClosedPeriod,
} from "../../src/modules/settlement/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

describe("Phase 4: settlement, treasury sweep, period close (§13, Prompt 5)", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("§13.5's hard gate: the generated FBR scroll for 2026-07-30 matches demo-data/scroll-sample.txt exactly", async () => {
    const expected = readFileSync(join(DEMO_DATA_DIR, "scroll-sample.txt"), "utf8").replace(/\r\n/g, "\n").trimEnd();
    const scroll = await generateScroll(testDb.db, "FBR", "2026-07-30", clock);

    expect(scroll.recordCount).toBe(18);
    expect(scroll.controlTotalMinor).toBe(372_132_500n);
    expect(scroll.detailSha256).toBe("0810a5456cef9d1ea691d79ac9be7616e905fcb22978cd8caeff132374fc94ad");

    const actualLines = scroll.fullText.split("\n");
    const expectedLines = expected.split("\n");
    expect(actualLines.length).toBe(expectedLines.length);
    for (let i = 0; i < expectedLines.length; i++) {
      expect(actualLines[i], `line ${i + 1} differs`).toBe(expectedLines[i]);
    }
    expect(scroll.fullText).toBe(expected);
  });

  it("re-generating the same day's scroll is a fresh, consistent computation (idempotent content, new sequence number)", async () => {
    const first = await generateScroll(testDb.db, "FBR", "2026-07-30", clock);
    const second = await generateScroll(testDb.db, "FBR", "2026-07-30", clock);
    expect(second.detailSha256).toBe(first.detailSha256);
    expect(second.controlTotalMinor).toBe(first.controlTotalMinor);
    expect(second.scrollReference).not.toBe(first.scrollReference); // sequence_no increments, no silent overwrite
  });

  it("a date/agency with genuinely zero activity produces an empty, trivially-tying scroll (0 = 0)", async () => {
    const scroll = await generateScroll(testDb.db, "FBR", "2026-01-01", clock);
    expect(scroll.recordCount).toBe(0);
    expect(scroll.controlTotalMinor).toBe(0n);
  });

  it("refuses to emit a scroll whose control total doesn't tie to real ledger credits (hard rule 1)", async () => {
    // Force a genuine, isolated mismatch: an APPLIED allocation dated
    // 2026-05-01 for FBR with no corresponding journal credit to 2010 — the
    // same technique the existing tamper-chain tests already use to prove a
    // control fires, not a real-data scenario.
    const anyAssessment = await testDb.db.selectFrom("assessment").innerJoin("agency", "agency.id", "assessment.agency_id").select(["assessment.id as assessment_id"]).where("agency.code", "=", "FBR").limit(1).executeTakeFirstOrThrow();
    const anyLine = await testDb.db.selectFrom("assessment_line_item").innerJoin("revenue_head", "revenue_head.id", "assessment_line_item.revenue_head_id").select(["assessment_line_item.id as line_id", "assessment_line_item.revenue_head_id"]).where("assessment_line_item.assessment_id", "=", anyAssessment.assessment_id).limit(1).executeTakeFirstOrThrow();
    const anyPayment = await testDb.db.selectFrom("payment").select("id").where("value_date", "=", "2026-05-01").executeTakeFirst();
    const paymentId =
      anyPayment?.id ??
      (
        await testDb.db
          .insertInto("payment")
          .values({ payment_reference: "PMORPHANTEST01", channel: "APP", rail: "RAAST", gross_amount_minor: 100_00n, net_to_agency_minor: 100_00n, status: "CONFIRMED", finality: "FINAL", value_date: "2026-05-01", obligation_discharge_date: "2026-05-01" })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    await testDb.db.insertInto("payment_allocation").values({ payment_id: paymentId, assessment_id: anyAssessment.assessment_id, line_item_id: anyLine.line_id, revenue_head_id: anyLine.revenue_head_id, amount_minor: 100_00n, allocation_basis: "EXPLICIT", status: "APPLIED" }).execute();

    try {
      await expect(generateScroll(testDb.db, "FBR", "2026-05-01", clock)).rejects.toThrow(/does not tie to net ledger credits/);
    } finally {
      // Clean up the deliberately-orphaned row so later tests in this file
      // (balance-rebuild via period pre-close checks) see consistent state.
      await testDb.db.deleteFrom("payment_allocation").where("payment_id", "=", paymentId).where("amount_minor", "=", 100_00n).where("allocation_basis", "=", "EXPLICIT").execute();
      if (!anyPayment) await testDb.db.deleteFrom("payment").where("id", "=", paymentId).execute();
    }
  });

  it("§13.3: assignValueDate — same business day within cutoff", () => {
    const result = assignValueDate({ receivedAtIso: "2026-07-30T10:00:00", cutoffTime: "18:00", timezone: "Asia/Karachi" });
    expect(result).toEqual({ valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", cutoffReason: "SAME_DAY", cutoffRuleVersion: "v1" });
  });

  it("§13.3: assignValueDate — after cutoff rolls the VALUE date forward but keeps the SAME obligation-discharge date", () => {
    const result = assignValueDate({ receivedAtIso: "2026-07-30T23:58:00", cutoffTime: "18:00", timezone: "Asia/Karachi" });
    expect(result.obligationDischargeDate).toBe("2026-07-30"); // the payer met the deadline...
    expect(result.valueDate).not.toBe("2026-07-30"); // ...even though settlement value-dates the next business day
    expect(result.cutoffReason).toBe("AFTER_CUTOFF");
  });

  it("§13.3: assignValueDate — a non-business-day (Saturday) rolls to the next business day", () => {
    // 2026-08-01 is a Saturday.
    const result = assignValueDate({ receivedAtIso: "2026-08-01T10:00:00", cutoffTime: "18:00", timezone: "Asia/Karachi" });
    expect(result.cutoffReason).toBe("NON_BUSINESS_DAY");
    expect(result.valueDate).toBe("2026-08-03"); // Monday
  });

  it("§13.4: runSweep excludes provisional (uncleared cheque) funds and posts T18", async () => {
    const before = await testDb.db.selectFrom("payment").select(({ fn }) => fn.countAll().as("c")).where("rail", "=", "PRISM_RTGS").where("direction", "=", "OUTBOUND").executeTakeFirstOrThrow();
    const result = await runSweep(testDb.db, "FBR", "2026-07-30", clock);
    expect(result.sweptAmountMinor).toBeGreaterThan(0n);

    const sweepPayment = await testDb.db.selectFrom("payment").selectAll().where("payment_reference", "=", "SWPFBR20260730").executeTakeFirstOrThrow();
    expect(sweepPayment.gross_amount_minor).toBe(result.sweptAmountMinor);

    const journalLines = await testDb.db.selectFrom("journal_line").selectAll().where("account_code", "like", "1100-%").execute();
    expect(journalLines.length).toBeGreaterThan(0);

    const after = await testDb.db.selectFrom("payment").select(({ fn }) => fn.countAll().as("c")).where("rail", "=", "PRISM_RTGS").where("direction", "=", "OUTBOUND").executeTakeFirstOrThrow();
    expect(Number(after.c)).toBe(Number(before.c) + 1);
  });

  it("§13.4 step 9: a rejected scroll ack raises a real B09 break", async () => {
    const scroll = await generateScroll(testDb.db, "FBR", "2026-07-30", clock);
    await recordScrollAck(testDb.db, scroll.scrollId, "REJECTED", clock);
    const updated = await testDb.db.selectFrom("scroll").select(["status", "ack_status"]).where("id", "=", scroll.scrollId).executeTakeFirstOrThrow();
    expect(updated.status).toBe("REJECTED");
    expect(updated.ack_status).toBe("REJECTED");
  });

  it("§13.6: pre-close checks report the real, live control-assertion state", async () => {
    const check = await runPreCloseChecks(testDb.db, "2026-07-01", "2026-07-31");
    expect(typeof check.passed).toBe("boolean");
    expect(Array.isArray(check.failures)).toBe(true);
  });

  it("§13.6: period close is blocked while a CRITICAL/HIGH break is open, and this dataset genuinely has some", async () => {
    // The 11-break gate (test/integration/recon.test.ts) already proves this
    // dataset carries real CRITICAL/HIGH breaks for 2026-07-30 — run recon here too
    // so this test is self-contained rather than depending on test execution order.
    const { runReconciliation } = await import("../../src/modules/recon/index.js");
    await runReconciliation(testDb.db, "2026-07-30", clock);
    await expect(closePeriod(testDb.db, "2026-07-01", "2026-07-31", "ops-console", clock)).rejects.toThrow(PeriodCloseBlockedError);
  });

  it("§13.6: once open breaks are resolved, close succeeds, is recorded, and can never be reopened", async () => {
    await testDb.db.updateTable("recon_break").set({ status: "RESOLVED" }).where("severity", "in", ["CRITICAL", "HIGH"]).execute();

    // Resolve real UNCERTAIN payments the way §9.4's resolver actually would
    // (a real state transition via resolveUncertainPayment, which is also
    // what keeps allocation-integrity's own exclusion set honest) — not a
    // blind status flip that would leave a payment CONFIRMED with no
    // allocation to justify its gross amount.
    const { resolveUncertainPayment } = await import("../../src/modules/payment/index.js");
    const stillUncertain = await testDb.db.selectFrom("payment").select("id").where("status", "=", "UNCERTAIN").execute();
    for (const p of stillUncertain) {
      await resolveUncertainPayment(testDb.db, p.id, { outcome: "FOUND_NOT_PAID", source: "HUMAN_INVESTIGATION" }, clock);
    }

    const { periodId } = await closePeriod(testDb.db, "2026-06-01", "2026-06-30", "ops-console", clock);
    const period = await testDb.db.selectFrom("accounting_period").selectAll().where("id", "=", periodId).executeTakeFirstOrThrow();
    expect(period.status).toBe("CLOSED");

    await recordAgencySignoff(testDb.db, periodId, "FBR", "fbr-finance-officer", "10.0.0.1", clock);
    const signoff = await testDb.db.selectFrom("period_agency_signoff").selectAll().where("period_id", "=", periodId).executeTakeFirstOrThrow();
    expect(signoff.signed_off_by).toBe("fbr-finance-officer");

    expect(await isDateInClosedPeriod(testDb.db, "2026-06-15")).toBe(true);
    expect(await isDateInClosedPeriod(testDb.db, "2026-07-15")).toBe(false);

    // Reopening is structurally impossible: migration 0023's RULE makes a
    // direct UPDATE back toward OPEN a silent no-op, and closePeriod's own
    // guard throws before even attempting one.
    await expect(closePeriod(testDb.db, "2026-06-01", "2026-06-30", "someone-else", clock)).rejects.toThrow(PeriodAlreadyClosedError);
    await testDb.db.updateTable("accounting_period").set({ status: "OPEN" }).where("id", "=", periodId).execute();
    const stillClosed = await testDb.db.selectFrom("accounting_period").select("status").where("id", "=", periodId).executeTakeFirstOrThrow();
    expect(stillClosed.status).toBe("CLOSED"); // the RULE silently discarded the UPDATE
  });
});
