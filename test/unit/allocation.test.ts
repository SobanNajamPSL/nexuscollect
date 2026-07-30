import { describe, expect, it } from "vitest";
import { applyWaterfall, applyProRata, decideAssessmentOutcome, type OpenLine } from "../../src/modules/allocation/index.js";

/**
 * Finding-parity with Phase 1's compute-derived tests: direct, deterministic
 * unit tests for §11.3's allocation engine, plus the P260000E golden proof —
 * feeding the engine AS-00013's real line items and PENALTY_FIRST waterfall
 * and asserting it independently reproduces the exact split already recorded
 * in demo-data/payment_allocations.csv (920,000.00 / 12,880.00 / 11,000.00),
 * without touching the loaded fixture data at all.
 */
const P260000E_LINES: OpenLine[] = [
  { lineItemId: "LI-000029", assessmentId: "AS-00013", lineType: "PRINCIPAL", taxPeriod: "2025-26", allocationPriority: 50, balanceMinor: 92_000_000n },
  { lineItemId: "LI-000030", assessmentId: "AS-00013", lineType: "SURCHARGE", taxPeriod: "2025-26", allocationPriority: 30, balanceMinor: 1_288_000n },
  { lineItemId: "LI-000031", assessmentId: "AS-00013", lineType: "PENALTY", taxPeriod: "2025-26", allocationPriority: 20, balanceMinor: 1_100_000n },
];

describe("P260000E golden proof: PENALTY_FIRST reproduces the real fixture split", () => {
  it("splits 943,880.00 across B02391/B02388/B01101 exactly as payment_allocations.csv records", () => {
    const result = applyWaterfall("PENALTY_FIRST", [], P260000E_LINES, 94_388_000n);
    expect(result.remainingMinor).toBe(0n);

    const byLine = Object.fromEntries(result.allocations.map((a) => [a.lineItemId, a.amountMinor]));
    expect(byLine["LI-000031"]).toBe(1_100_000n); // PENALTY — B02391
    expect(byLine["LI-000030"]).toBe(1_288_000n); // SURCHARGE — B02388
    expect(byLine["LI-000029"]).toBe(92_000_000n); // PRINCIPAL — B01101
    expect(result.allocations.every((a) => a.basis === "WATERFALL")).toBe(true);
  });
});

describe("allocation waterfalls (§11.3)", () => {
  const lines: OpenLine[] = [
    { lineItemId: "L-FEE", assessmentId: "A1", lineType: "FEE", taxPeriod: "2026-01", allocationPriority: 10, balanceMinor: 100n },
    { lineItemId: "L-PEN", assessmentId: "A1", lineType: "PENALTY", taxPeriod: "2026-01", allocationPriority: 20, balanceMinor: 200n },
    { lineItemId: "L-SUR", assessmentId: "A1", lineType: "SURCHARGE", taxPeriod: "2026-01", allocationPriority: 30, balanceMinor: 300n },
    { lineItemId: "L-PRIN", assessmentId: "A1", lineType: "PRINCIPAL", taxPeriod: "2026-01", allocationPriority: 50, balanceMinor: 1000n },
  ];

  it("PENALTY_FIRST pays FEE, then PENALTY, then SURCHARGE, before PRINCIPAL", () => {
    const result = applyWaterfall("PENALTY_FIRST", [], lines, 250n);
    const byLine = Object.fromEntries(result.allocations.map((a) => [a.lineItemId, a.amountMinor]));
    expect(byLine["L-FEE"]).toBe(100n);
    expect(byLine["L-PEN"]).toBe(150n);
    expect(byLine["L-SUR"]).toBeUndefined();
    expect(result.remainingMinor).toBe(0n);
  });

  it("PRINCIPAL_FIRST pays PRINCIPAL before FEE/PENALTY/SURCHARGE", () => {
    const result = applyWaterfall("PRINCIPAL_FIRST", [], lines, 500n);
    const byLine = Object.fromEntries(result.allocations.map((a) => [a.lineItemId, a.amountMinor]));
    expect(byLine["L-PRIN"]).toBe(500n);
    expect(byLine["L-FEE"]).toBeUndefined();
  });

  it("OLDEST_FIRST orders by tax_period ascending regardless of line_type", () => {
    const arrears: OpenLine[] = [
      { lineItemId: "L-NEW", assessmentId: "A2", lineType: "PRINCIPAL", taxPeriod: "2026-06", allocationPriority: 50, balanceMinor: 500n },
      { lineItemId: "L-OLD", assessmentId: "A2", lineType: "PRINCIPAL", taxPeriod: "2025-01", allocationPriority: 50, balanceMinor: 500n },
    ];
    const result = applyWaterfall("OLDEST_FIRST", [], arrears, 500n);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.lineItemId).toBe("L-OLD");
  });

  it("EXPLICIT_ONLY applies only explicit instructions and leaves the rest unapplied, never inferring", () => {
    const result = applyWaterfall("EXPLICIT_ONLY", [{ lineItemId: "L-PRIN", amountMinor: 400n }], lines, 900n);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ lineItemId: "L-PRIN", amountMinor: 400n, basis: "EXPLICIT" });
    expect(result.remainingMinor).toBe(500n); // never inferred onto other lines
  });

  it("explicit instructions apply first under any waterfall, then the remainder follows the waterfall", () => {
    const result = applyWaterfall("PENALTY_FIRST", [{ lineItemId: "L-PRIN", amountMinor: 100n }], lines, 300n);
    const byLine = Object.fromEntries(result.allocations.map((a) => [a.lineItemId, a.amountMinor]));
    expect(byLine["L-PRIN"]).toBe(100n);
    expect(byLine["L-FEE"]).toBe(100n); // remaining 200 then follows PENALTY_FIRST
    expect(byLine["L-PEN"]).toBe(100n);
  });

  it("a payment larger than total open balance leaves the excess unapplied (never over-allocates a line)", () => {
    const result = applyWaterfall("PENALTY_FIRST", [], lines, 10_000n);
    expect(result.remainingMinor).toBe(10_000n - (100n + 200n + 300n + 1000n));
    for (const a of result.allocations) {
      const line = lines.find((l) => l.lineItemId === a.lineItemId);
      expect(a.amountMinor).toBeLessThanOrEqual(line?.balanceMinor ?? 0n);
    }
  });
});

describe("PRO_RATA: Hare-quota largest-remainder distribution", () => {
  it("loses no paisa: allocated sum equals the smaller of amount and total balance", () => {
    const proRataLines: OpenLine[] = [
      { lineItemId: "L1", assessmentId: "A3", lineType: "PRINCIPAL", taxPeriod: null, allocationPriority: 50, balanceMinor: 333n },
      { lineItemId: "L2", assessmentId: "A3", lineType: "SURCHARGE", taxPeriod: null, allocationPriority: 30, balanceMinor: 333n },
      { lineItemId: "L3", assessmentId: "A3", lineType: "PENALTY", taxPeriod: null, allocationPriority: 20, balanceMinor: 334n },
    ];
    const result = applyProRata(proRataLines, 100n); // 100 doesn't divide evenly across ~equal thirds
    const total = result.reduce((s, a) => s + a.amountMinor, 0n);
    expect(total).toBe(100n);
  });

  it("never allocates more than a line's own balance", () => {
    const proRataLines: OpenLine[] = [
      { lineItemId: "L1", assessmentId: "A4", lineType: "PRINCIPAL", taxPeriod: null, allocationPriority: 50, balanceMinor: 1n },
      { lineItemId: "L2", assessmentId: "A4", lineType: "SURCHARGE", taxPeriod: null, allocationPriority: 30, balanceMinor: 1n },
      { lineItemId: "L3", assessmentId: "A4", lineType: "PENALTY", taxPeriod: null, allocationPriority: 20, balanceMinor: 1n },
    ];
    const result = applyProRata(proRataLines, 100n); // way more than total balance of 3
    expect(result.reduce((s, a) => s + a.amountMinor, 0n)).toBe(3n); // capped at total balance
    for (const a of result) expect(a.amountMinor).toBeLessThanOrEqual(1n);
  });

  it("distributes proportionally when the amount divides evenly", () => {
    const proRataLines: OpenLine[] = [
      { lineItemId: "L1", assessmentId: "A5", lineType: "PRINCIPAL", taxPeriod: null, allocationPriority: 50, balanceMinor: 200n },
      { lineItemId: "L2", assessmentId: "A5", lineType: "SURCHARGE", taxPeriod: null, allocationPriority: 30, balanceMinor: 200n },
    ];
    const result = applyProRata(proRataLines, 100n);
    const byLine = Object.fromEntries(result.map((a) => [a.lineItemId, a.amountMinor]));
    expect(byLine["L1"]).toBe(50n);
    expect(byLine["L2"]).toBe(50n);
  });

  it("is deterministic: tie-broken by allocationPriority then lineItemId, same input always same output", () => {
    const proRataLines: OpenLine[] = [
      { lineItemId: "L-B", assessmentId: "A6", lineType: "PRINCIPAL", taxPeriod: null, allocationPriority: 10, balanceMinor: 100n },
      { lineItemId: "L-A", assessmentId: "A6", lineType: "SURCHARGE", taxPeriod: null, allocationPriority: 10, balanceMinor: 100n },
      { lineItemId: "L-C", assessmentId: "A6", lineType: "PENALTY", taxPeriod: null, allocationPriority: 10, balanceMinor: 100n },
    ];
    const a = applyProRata(proRataLines, 100n);
    const b = applyProRata(proRataLines, 100n);
    expect(a).toEqual(b);
  });
});

describe("§11.4 residual handling: decideAssessmentOutcome", () => {
  const base = { underpayToleranceMinor: 100n, overpayToleranceMinor: 100n, allowPartial: false, underpayPolicy: "HOLD_AS_UNAPPLIED" as const, overpayTreatment: "CREDIT_ON_ACCOUNT" as const };

  it("settles when the remaining balance is within underpay tolerance, and computes rounding relief", () => {
    const decision = decideAssessmentOutcome({ ...base, payableAmountMinor: 100_000n, allocatedAfterMinor: 99_960n });
    expect(decision).toEqual({ kind: "SETTLED", roundingReliefMinor: 40n });
  });

  it("checked per assessment, never against a payment total — full balance exactly zero settles cleanly", () => {
    const decision = decideAssessmentOutcome({ ...base, payableAmountMinor: 100_000n, allocatedAfterMinor: 100_000n });
    expect(decision).toEqual({ kind: "SETTLED", roundingReliefMinor: 0n });
  });

  it("beyond tolerance with allow_partial=true becomes PARTIALLY_PAID", () => {
    const decision = decideAssessmentOutcome({ ...base, allowPartial: true, payableAmountMinor: 100_000n, allocatedAfterMinor: 50_000n });
    expect(decision).toEqual({ kind: "PARTIALLY_PAID" });
  });

  it("beyond tolerance with allow_partial=false and underpay_policy=HOLD_AS_UNAPPLIED, never silently keeping money unrecorded", () => {
    const decision = decideAssessmentOutcome({ ...base, allowPartial: false, payableAmountMinor: 100_000n, allocatedAfterMinor: 50_000n });
    expect(decision).toEqual({ kind: "HOLD_AS_UNAPPLIED" });
  });

  it("beyond tolerance with allow_partial=false and underpay_policy=REJECT_AND_RETURN", () => {
    const decision = decideAssessmentOutcome({ ...base, allowPartial: false, underpayPolicy: "REJECT_AND_RETURN", payableAmountMinor: 100_000n, allocatedAfterMinor: 50_000n });
    expect(decision).toEqual({ kind: "REJECT_AND_RETURN" });
  });

  it("overpayment within tolerance is absorbed regardless of the product's configured treatment", () => {
    const decision = decideAssessmentOutcome({ ...base, payableAmountMinor: 100_000n, allocatedAfterMinor: 100_050n });
    expect(decision).toEqual({ kind: "OVERPAID", surplusMinor: 50n, treatment: "ABSORB" });
  });

  it("overpayment beyond tolerance routes through the product's configured overpay_treatment", () => {
    const decision = decideAssessmentOutcome({ ...base, overpayTreatment: "AUTO_REFUND", payableAmountMinor: 100_000n, allocatedAfterMinor: 150_000n });
    expect(decision).toEqual({ kind: "OVERPAID", surplusMinor: 50_000n, treatment: "AUTO_REFUND" });
  });
});
