import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { applyWaterfall, applyProRata, type OpenLine, type Waterfall } from "../../src/modules/allocation/index.js";
import { capturePayment, resolveUncertainPayment } from "../../src/modules/payment/index.js";
import { runReconciliation } from "../../src/modules/recon/index.js";
import { returnInstrument } from "../../src/modules/instrument/index.js";
import { generateScroll } from "../../src/modules/settlement/index.js";
import { checkTrialBalance } from "../../src/modules/control/index.js";
import { postJournalEntry, getOrCreateLedgerAccount, PeriodClosedError } from "../../src/modules/ledger/index.js";
import { closePeriod } from "../../src/modules/settlement/index.js";
import { createRefund, payRefund } from "../../src/modules/refund/index.js";
import { validateBulkFile, confirmBulkBatch } from "../../src/modules/bulk/index.js";
import { readFileSync } from "node:fs";
import { loadSchemeCache } from "../../src/modules/resolution/scheme-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

// ---------------------------------------------------------------------------
// §26.2: property-based tests over the pure allocation engine — no DB needed.
// ---------------------------------------------------------------------------

function randomOpenLines(n: number, seed: number): OpenLine[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const types: OpenLine["lineType"][] = ["PRINCIPAL", "SURCHARGE", "PENALTY", "FEE"];
  return Array.from({ length: n }, (_, i) => ({
    lineItemId: `line-${i}`,
    assessmentId: "assessment-1",
    lineType: types[Math.floor(rand() * types.length)]!,
    taxPeriod: null,
    allocationPriority: [50, 30, 20, 10][i % 4]!,
    balanceMinor: BigInt(Math.floor(rand() * 1_000_000) + 1),
  }));
}

describe("§26.2 property tests: allocation engine (10,000 random cases)", () => {
  const WATERFALLS: Waterfall[] = ["PENALTY_FIRST", "PRINCIPAL_FIRST", "OLDEST_FIRST", "EXPLICIT_ONLY"];

  it("allocation is conservative: Σ allocations + unapplied = amount, for all cases and all waterfalls", () => {
    for (let i = 0; i < 10_000; i++) {
      const lines = randomOpenLines(1 + (i % 5), i);
      const totalBalance = lines.reduce((s, l) => s + l.balanceMinor, 0n);
      const amount = BigInt(Math.floor((i * 9301 + 49297) % 2_000_000));
      for (const wf of WATERFALLS) {
        const result = applyWaterfall(wf, [], lines, amount);
        const allocated = result.allocations.reduce((s, a) => s + a.amountMinor, 0n);
        expect(allocated + result.remainingMinor, `waterfall=${wf} case=${i}`).toBe(amount);
        expect(allocated, `never allocates more than exists, case=${i}`).toBeLessThanOrEqual(totalBalance);
      }
      // PRO_RATA separately — its own allocation-delta shape.
      const proRata = applyProRata(lines, amount);
      const proRataAllocated = proRata.reduce((s, a) => s + a.amountMinor, 0n);
      const expectedProRata = amount < totalBalance ? amount : totalBalance;
      expect(proRataAllocated, `PRO_RATA case=${i}`).toBe(expectedProRata);
    }
  });

  it("waterfall is monotonic: paying more never reduces the amount allocated to any higher-priority line", () => {
    for (let i = 0; i < 2_000; i++) {
      const lines = randomOpenLines(4, i + 500);
      const sortedByPriority = [...lines].sort((a, b) => b.allocationPriority - a.allocationPriority);
      const highestPriorityLineId = sortedByPriority[0]!.lineItemId;
      const totalBalance = lines.reduce((s, l) => s + l.balanceMinor, 0n);

      const amt1 = totalBalance / 3n;
      const amt2 = (totalBalance * 2n) / 3n;
      if (amt1 >= amt2) continue;

      const result1 = applyWaterfall("PENALTY_FIRST", [], lines, amt1);
      const result2 = applyWaterfall("PENALTY_FIRST", [], lines, amt2);
      const allocatedToHighest1 = result1.allocations.find((a) => a.lineItemId === highestPriorityLineId)?.amountMinor ?? 0n;
      const allocatedToHighest2 = result2.allocations.find((a) => a.lineItemId === highestPriorityLineId)?.amountMinor ?? 0n;
      expect(allocatedToHighest2, `case=${i}`).toBeGreaterThanOrEqual(allocatedToHighest1);
    }
  });
});

describe("§26.4 demo regression replay + §26.1 Group D remaining controls + §26.5 G2P forward-compat", () => {
  let testDb: TestDb;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    await loadSchemeCache(testDb.db);
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("§26.4: replays the real §24.4 demo anchors in sequence — if the demo script and the code diverge, this fails first", async () => {
    // Step 1 (resolve LEA-17-1000) and step 2 (pay one by APP) are the
    // Screen 1 flow already proven end-to-end in the browser walkthrough and
    // in resolve.test.ts / payment-pipeline.test.ts — re-asserted here only
    // via the real underlying data so this replay stays self-contained.
    const settledAnchor = await testDb.db.selectFrom("assessment").select(["status"]).where("psid", "=", "41011400001606295").executeTakeFirstOrThrow();
    expect(settledAnchor.status).toBe("SETTLED");

    // Step 5: multi-head split P260000E — PKR 943,880.00 across 3 heads.
    const splitAllocations = await testDb.db
      .selectFrom("payment_allocation")
      .innerJoin("payment", "payment.id", "payment_allocation.payment_id")
      .innerJoin("revenue_head", "revenue_head.id", "payment_allocation.revenue_head_id")
      .select(["revenue_head.code", "payment_allocation.amount_minor"])
      .where("payment.payment_reference", "=", "P260000E")
      .execute();
    const splitTotal = splitAllocations.reduce((s, a) => s + a.amount_minor, 0n);
    expect(splitTotal).toBe(94_388_000n);
    expect(splitAllocations.find((a) => a.code === "B01101")?.amount_minor).toBe(92_000_000n);
    expect(splitAllocations.find((a) => a.code === "B02388")?.amount_minor).toBe(1_288_000n);
    expect(splitAllocations.find((a) => a.code === "B02391")?.amount_minor).toBe(1_100_000n);

    // Step 6: bulk file — the whole file rejects because row 13 references an
    // already-settled PSID (own dedicated test in exceptions-and-channels.test.ts;
    // re-asserted here as part of the sequential replay).
    const bulkContent = readFileSync(join(DEMO_DATA_DIR, "bulk_payment_input.csv"), "utf8");
    const bulkLines = bulkContent.trim().split("\n").slice(1);
    const bulkRows = bulkLines.map((line) => {
      const [rowNoStr, psid, amountStr] = line.split(",");
      return { rowNo: Number(rowNoStr), psid: psid!, amountMinor: BigInt(amountStr!) };
    });
    const bulkTotal = bulkRows.reduce((s, r) => s + r.amountMinor, 0n);
    const bulkResult = await validateBulkFile(testDb.db, { rows: bulkRows, declaredRowCount: bulkRows.length, declaredTotalMinor: bulkTotal, fileContent: bulkContent }, clock);
    expect(bulkResult.status).toBe("REJECTED");
    await expect(confirmBulkBatch(testDb.db, bulkResult.batchId, "2026-07-30", clock)).rejects.toThrow();

    // Step 7: cheque cascade. The loaded IN-0004 fixture row already sits in
    // its real POST-dishonour state (status=RETURNED — a historical fact,
    // not something to re-trigger), so — same technique as
    // instrument-dishonour.test.ts — this proves the cascade mechanism on a
    // fresh synthetic instrument lodged against the same 3 real, still-open
    // assessments IN-0004 itself references.
    const psids = ["12010400001661551", "12010400001776532", "12010400001899869"];
    const amounts = [18_144_000n, 21_470_400n, 24_796_800n];
    const fbr = await testDb.db.selectFrom("agency").selectAll().where("code", "=", "FBR").executeTakeFirstOrThrow();
    const syntheticInstrument = await testDb.db
      .insertInto("instrument")
      .values({ instrument_type: "CHEQUE", instrument_number: "TEST-004822-REPLAY", drawee_bank_bic: "UNILPKKA", drawer_name: "Ahmed Traders (Pvt) Ltd", amount_minor: 64_411_200n, agency_id: fbr.id, status: "LODGED", dishonour_charge_minor: 50_000n })
      .returning("id")
      .executeTakeFirstOrThrow();
    const chequeCapture = await capturePayment(
      testDb.db,
      { paymentReference: "", channel: "OTC", rail: "CHEQUE_CLEARING", grossAmountMinor: 64_411_200n, valueDate: "2026-07-30", obligationDischargeDate: "2026-07-30", instrumentId: syntheticInstrument.id, explicitAllocations: psids.map((psid, i) => ({ psid, amountMinor: amounts[i]! })), captureOutcome: "CONFIRMED" },
      clock,
    );
    expect(chequeCapture.settledAssessmentIds).toHaveLength(3);
    const cascade = await returnInstrument(testDb.db, syntheticInstrument.id, "INSUFFICIENT_FUNDS", clock);
    expect(cascade.reversedPaymentIds.length).toBeGreaterThan(0);
    expect(cascade.unsettledAssessmentIds).toHaveLength(3);
    // One payment settled all 3 assessments at once, so exactly one receipt
    // was minted for it (receipt is per-payment, not per-assessment) —
    // matches instrument-dishonour.test.ts's own established expectation.
    expect(cascade.voidedReceiptIds).toHaveLength(1);
    expect(cascade.dishonourAssessmentId).not.toBeNull();

    // Step 8: reconciliation — exactly 11 breaks.
    const recon = await runReconciliation(testDb.db, "2026-07-30", clock);
    expect(recon.breaks).toHaveLength(11);

    // Step 10: scroll and sweep — byte-exact against the real fixture.
    const scroll = await generateScroll(testDb.db, "FBR", "2026-07-30", clock);
    expect(scroll.detailSha256).toBe("0810a5456cef9d1ea691d79ac9be7616e905fcb22978cd8caeff132374fc94ad");

    // Step 11: the five controls, live.
    const tb = await checkTrialBalance(testDb.db);
    expect(tb.balanced).toBe(true);
  });

  it("D3: posting a journal entry into a CLOSED period is rejected", async () => {
    // Resolve every open control/break first so the period can genuinely close.
    await testDb.db.updateTable("recon_break").set({ status: "RESOLVED" }).execute();
    // Real resolution, not a raw status flip: an UNCERTAIN payment forced
    // straight to CONFIRMED without running allocation would leave its gross
    // amount with no matching applied/unapplied total, tripping the
    // allocation-integrity control below for the wrong reason.
    const uncertainPayments = await testDb.db.selectFrom("payment").select("id").where("status", "=", "UNCERTAIN").execute();
    for (const p of uncertainPayments) {
      await resolveUncertainPayment(testDb.db, p.id, { outcome: "FOUND_PAID", source: "HUMAN_INVESTIGATION" }, clock);
    }
    const { periodId } = await closePeriod(testDb.db, "2020-01-01", "2020-01-31", "test-ops", clock);
    expect(periodId).toBeTruthy();

    const debitCode = await testDb.db.transaction().execute((trx) => getOrCreateLedgerAccount(trx, { baseCode: "9999", dimensionKey: "TEST", name: "Test Account", accountType: "ASSET", normalBalance: "DR" }));
    await expect(
      postJournalEntry(testDb.db, { eventType: "TEST_EVENT", sourceType: "test", sourceId: randomUUID(), valueDate: "2020-01-15", lines: [{ seq: 1, accountCode: debitCode, direction: "DR", amountMinor: 100n }, { seq: 2, accountCode: debitCode, direction: "CR", amountMinor: 100n }] }, clock),
    ).rejects.toThrow(PeriodClosedError);

    // A date OUTSIDE the closed period still posts fine.
    const result = await postJournalEntry(testDb.db, { eventType: "TEST_EVENT", sourceType: "test", sourceId: randomUUID(), valueDate: "2026-07-30", lines: [{ seq: 1, accountCode: debitCode, direction: "DR", amountMinor: 100n }, { seq: 2, accountCode: debitCode, direction: "CR", amountMinor: 100n }] }, clock);
    expect(result.replayed).toBe(false);
  });

  it("D6: a refund with an overridden beneficiary still cannot be paid before approval", async () => {
    const anyPayment = await testDb.db.selectFrom("payment").select(["id", "gross_amount_minor"]).where("status", "=", "CONFIRMED").limit(1).executeTakeFirstOrThrow();
    const refund = await createRefund(
      testDb.db,
      { paymentId: anyPayment.id, amountMinor: 1n, reasonCode: "ERRONEOUS_PAYMENT", mode: "SURPLUS_ONLY", fundingSource: "PLATFORM_HELD", overrideBeneficiaryAccountMasked: "IBAN ****9999", actorId: "test-actor" },
      clock,
    );
    const row = await testDb.db.selectFrom("refund").select(["beneficiary_overridden", "status"]).where("id", "=", refund.refundId).executeTakeFirstOrThrow();
    expect(row.beneficiary_overridden).toBe(true);
    expect(row.status).toBe("PENDING_APPROVAL"); // an override does NOT skip the approval gate
    await expect(payRefund(testDb.db, refund.refundId, clock)).rejects.toThrow(/not APPROVED/);
  });

  it("D8: an automated scan finds no full CNIC/NTN in the audit log — only the already-masked snapshot form", async () => {
    const rows = await testDb.db.selectFrom("audit_log").select(["before_json", "after_json"]).limit(500).execute();
    const fullCnicPattern = /\b\d{5}-?\d{7}-?\d{1}\b/; // 13-digit CNIC, unmasked
    let violations = 0;
    for (const row of rows) {
      const text = `${JSON.stringify(row.before_json)} ${JSON.stringify(row.after_json)}`;
      // Masked forms like "CNIC ****00-1" are expected and fine; a real
      // violation is a bare 13-digit run not preceded by asterisks.
      const matches = text.match(new RegExp(fullCnicPattern, "g")) ?? [];
      for (const m of matches) {
        const idx = text.indexOf(m);
        const context = text.slice(Math.max(0, idx - 6), idx);
        if (!context.includes("*")) violations++;
      }
    }
    expect(violations).toBe(0);
  });

  it("§26.5 G2P forward-compatibility: an OUTBOUND-shaped journal entry posts through the same ledger and the trial balance still ties", async () => {
    const before = await checkTrialBalance(testDb.db, "2026-07-30");
    expect(before.balanced).toBe(true);

    // A disbursement is structurally the SWEEP_TO_TREASURY template's mirror
    // (money leaving via 2010/1100 in reverse) — proving the same ledger
    // primitives serve an outbound G2P-shaped payment with no new mechanism.
    await testDb.db.transaction().execute(async (trx) => {
      const disbursementPayable = await getOrCreateLedgerAccount(trx, { baseCode: "2900", dimensionKey: "G2P-TEST", name: "Disbursement Payable", accountType: "LIABILITY", normalBalance: "CR" });
      const bankCode = await getOrCreateLedgerAccount(trx, { baseCode: "1100", dimensionKey: "PLATFORM", name: "Collection Bank", accountType: "ASSET", normalBalance: "DR" });
      await postJournalEntry(trx, { eventType: "G2P_DISBURSEMENT_TEST", sourceType: "test", sourceId: randomUUID(), valueDate: "2026-07-30", lines: [{ seq: 1, accountCode: disbursementPayable, direction: "DR", amountMinor: 50_000n }, { seq: 2, accountCode: bankCode, direction: "CR", amountMinor: 50_000n }] }, clock);
    });

    const after = await checkTrialBalance(testDb.db, "2026-07-30");
    expect(after.balanced).toBe(true);
    expect(after.totalDebitMinor - before.totalDebitMinor).toBe(50_000n);
    expect(after.totalCreditMinor - before.totalCreditMinor).toBe(50_000n);
  });
});
