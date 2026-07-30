import { describe, expect, it } from "vitest";
import { computeDerived, COMPUTE_DERIVED_RULE_VERSION, type SurchargeRule, type EarlyDiscountRule } from "../../src/modules/obligation/compute-derived.js";

/**
 * Finding O (audit): direct, deterministic unit tests for §15.4's derived-
 * amount computation — surcharge cap/floor, grace days, discount boundary,
 * rounding, determinism, rule version in output, no mutation of principal.
 * Previously only exercised indirectly through one end-to-end resolve anchor.
 * Rule values below match demo-data's real FBR-IT-COMP-style surcharge
 * (12% p.a., ACT_365, from due_date, capped 100% of principal, rounded to
 * 100 paisa) and PSCA-CHALLAN-MOV's real early-discount config (25%, 10 days
 * from issue) — see config/product-derived-rules.json.
 */
const SURCHARGE_RULE: SurchargeRule = {
  basis: "DAILY_SIMPLE",
  rate_pct_per_annum: 12,
  accrues_on: "PRINCIPAL_ONLY",
  grace_days: 0,
  start_from: "DUE_DATE",
  compounding: "NONE",
  day_count: "ACT_365",
  max_pct_of_principal: 100,
  round_to_minor: 100,
};

const DISCOUNT_RULE: EarlyDiscountRule = {
  basis: "PCT_OF_PRINCIPAL",
  value_pct: 25,
  valid_until: { type: "DAYS_FROM_ISSUE", days: 10 },
  applies_to_line_types: ["PRINCIPAL"],
};

const BASE_INPUT = {
  principalMinor: 500_000n,
  otherLinesMinor: 0n,
  issueDate: "2026-07-01",
  dueDate: "2026-08-01",
  asOfDate: "2026-08-01",
  surchargeRule: null,
  earlyDiscountRule: null,
  roundingRule: null,
} as const;

describe("compute_derived (§15.4)", () => {
  it("no surcharge before the due date", () => {
    const result = computeDerived({ ...BASE_INPUT, surchargeRule: SURCHARGE_RULE, asOfDate: "2026-08-01" });
    expect(result.surchargeAccruedMinor).toBe(0n);
  });

  it("surcharge accrues daily-simple from the day after due_date", () => {
    // 10 days overdue: 500,000 * 12% / 365 * 10 = 1643.83..., rounded to nearest 100 -> 1600
    const result = computeDerived({ ...BASE_INPUT, surchargeRule: SURCHARGE_RULE, asOfDate: "2026-08-11" });
    expect(result.surchargeAccruedMinor).toBeGreaterThan(0n);
    expect(result.surchargeAccruedMinor % 100n).toBe(0n); // respects round_to_minor
  });

  it("grace_days delays accrual start", () => {
    const ruleWithGrace: SurchargeRule = { ...SURCHARGE_RULE, grace_days: 5 };
    const withinGrace = computeDerived({ ...BASE_INPUT, surchargeRule: ruleWithGrace, asOfDate: "2026-08-05" }); // 4 days overdue, within 5-day grace
    expect(withinGrace.surchargeAccruedMinor).toBe(0n);

    const pastGrace = computeDerived({ ...BASE_INPUT, surchargeRule: ruleWithGrace, asOfDate: "2026-08-10" }); // 9 days overdue, past 5-day grace
    expect(pastGrace.surchargeAccruedMinor).toBeGreaterThan(0n);
  });

  it("surcharge is capped at max_pct_of_principal even after years overdue", () => {
    // At 12%/yr simple, principal doubles (100% surcharge) after ~8.3 years —
    // 10 years overdue safely breaches the cap.
    const result = computeDerived({ ...BASE_INPUT, surchargeRule: SURCHARGE_RULE, asOfDate: "2036-08-01" });
    const cap = (500_000n * 100n) / 100n; // 100% of principal
    expect(result.surchargeAccruedMinor).toBeLessThanOrEqual(cap);
    expect(result.surchargeAccruedMinor).toBe(cap); // definitely breached the cap by 10 years at 12%/yr
  });

  it("surcharge never goes negative for a not-yet-due assessment", () => {
    const result = computeDerived({ ...BASE_INPUT, surchargeRule: SURCHARGE_RULE, dueDate: "2026-09-01", asOfDate: "2026-08-01" });
    expect(result.surchargeAccruedMinor).toBe(0n);
  });

  it("early discount is live strictly through issue_date + valid_until.days", () => {
    const onBoundary = computeDerived({ ...BASE_INPUT, earlyDiscountRule: DISCOUNT_RULE, issueDate: "2026-07-01", asOfDate: "2026-07-11" });
    expect(onBoundary.discountAppliedMinor).toBeGreaterThan(0n); // exactly on the boundary day — still live
    expect(onBoundary.discountExpiresOn).toBe("2026-07-11");

    const dayAfter = computeDerived({ ...BASE_INPUT, earlyDiscountRule: DISCOUNT_RULE, issueDate: "2026-07-01", asOfDate: "2026-07-12" });
    expect(dayAfter.discountAppliedMinor).toBe(0n); // one day past the boundary — expired
  });

  it("early discount is exactly value_pct of principal when live", () => {
    const result = computeDerived({ ...BASE_INPUT, earlyDiscountRule: DISCOUNT_RULE, issueDate: "2026-07-01", asOfDate: "2026-07-05" });
    expect(result.discountAppliedMinor).toBe(125_000n); // 25% of 500,000
  });

  it("NEAREST_1 rounding rounds the final payable to the nearest whole PKR (100 paisa)", () => {
    const result = computeDerived({ ...BASE_INPUT, principalMinor: 500_033n, roundingRule: "NEAREST_1" });
    expect(result.payableAmountMinor % 100n).toBe(0n);
  });

  it("NONE rounding leaves the payable amount exact", () => {
    const result = computeDerived({ ...BASE_INPUT, principalMinor: 500_033n, roundingRule: "NONE" });
    expect(result.payableAmountMinor).toBe(500_033n);
  });

  it("is deterministic: identical inputs always produce identical output", () => {
    const input = { ...BASE_INPUT, principalMinor: 1_234_567n, surchargeRule: SURCHARGE_RULE, earlyDiscountRule: DISCOUNT_RULE, asOfDate: "2026-09-15" };
    const a = computeDerived(input);
    const b = computeDerived(input);
    expect(a).toEqual(b);
  });

  it("reports the rule version in every result", () => {
    const result = computeDerived(BASE_INPUT);
    expect(result.ruleVersion).toBe(COMPUTE_DERIVED_RULE_VERSION);
  });

  it("never mutates its input (principal stays untouched)", () => {
    const input = { ...BASE_INPUT, principalMinor: 500_000n, surchargeRule: SURCHARGE_RULE, earlyDiscountRule: DISCOUNT_RULE, asOfDate: "2026-09-01" };
    const snapshot = JSON.parse(JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    computeDerived(input);
    const after = JSON.parse(JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(after).toEqual(snapshot);
    expect(input.principalMinor).toBe(500_000n);
  });

  it("surcharge and discount combine on the same assessment without interfering", () => {
    // Overdue (past due_date) AND still within its independent, issue-anchored
    // discount window (issue_date+10 = 2026-07-11) is a contradiction for a
    // single real product, but the function itself must not couple the two
    // computations incorrectly — both apply independently, purely from the dates.
    const result = computeDerived({ ...BASE_INPUT, principalMinor: 500_000n, surchargeRule: SURCHARGE_RULE, earlyDiscountRule: DISCOUNT_RULE, issueDate: "2026-07-01", dueDate: "2026-07-05", asOfDate: "2026-07-10" });
    expect(result.surchargeAccruedMinor).toBeGreaterThan(0n); // 5 days overdue
    expect(result.discountAppliedMinor).toBe(125_000n); // still within issue_date+10 days
    expect(result.payableAmountMinor).toBe(500_000n + result.surchargeAccruedMinor - result.discountAppliedMinor);
  });

  it("handles a partially-paid assessment's outstanding-balance math the same way resolve does (no surcharge/discount rule configured)", () => {
    // Mirrors AS-00004 (PSID 12010100000485997): FBR-IT-COMP has neither rule
    // configured, so payableAmountMinor should equal principal + other lines exactly.
    const result = computeDerived({ principalMinor: 49_250_000n, otherLinesMinor: 689_500n + 650_000n, issueDate: "2026-01-01", dueDate: "2026-02-01", asOfDate: "2026-07-30", surchargeRule: null, earlyDiscountRule: null, roundingRule: null });
    expect(result.payableAmountMinor).toBe(50_589_500n);
    expect(result.surchargeAccruedMinor).toBe(0n);
    expect(result.discountAppliedMinor).toBe(0n);
  });
});
