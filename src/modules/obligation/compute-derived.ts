/**
 * §15.4 "Derived amount rules — surcharge, discount, rounding." Config is
 * declarative JSON on `collection_product` (`surcharge_rule`,
 * `early_discount_rule`, `rounding_rule`), "evaluated at resolution time... so
 * the payer's quote is provable." Hard requirements (§15.4, verbatim intent):
 *   - same inputs -> identical output forever (deterministic, versioned)
 *   - never mutate assessed_amount_minor itself
 *   - recompute on every read, bounded (cap and floor)
 *
 * This is a pure function: no clock access inside, no DB access inside. The
 * caller supplies `asOfDate` (from the injected Clock) and the rule JSON
 * (already loaded from the DB). That's what makes it trivially unit-testable
 * and provably deterministic — same three inputs, same output, always.
 */

export const COMPUTE_DERIVED_RULE_VERSION = "v1";

export interface SurchargeRule {
  basis: "DAILY_SIMPLE";
  rate_pct_per_annum: number;
  accrues_on: "PRINCIPAL_ONLY";
  grace_days: number;
  start_from: "DUE_DATE";
  compounding: "NONE";
  day_count: "ACT_365";
  max_pct_of_principal: number;
  round_to_minor: number;
}

export interface EarlyDiscountRule {
  basis: "PCT_OF_PRINCIPAL";
  value_pct: number;
  valid_until: { type: "DAYS_FROM_ISSUE"; days: number };
  applies_to_line_types: readonly string[];
}

export type RoundingRule = "NEAREST_1" | "NONE";

export interface ComputeDerivedInput {
  principalMinor: bigint;
  /** Sum of any non-principal line items already on the assessment (fee, penalty, etc.) — passed through unchanged. */
  otherLinesMinor: bigint;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  asOfDate: string; // YYYY-MM-DD — the clock's today, never `new Date()` inside this module
  surchargeRule: SurchargeRule | null;
  earlyDiscountRule: EarlyDiscountRule | null;
  roundingRule: RoundingRule | null;
}

export interface ComputeDerivedResult {
  surchargeAccruedMinor: bigint;
  discountAppliedMinor: bigint;
  payableAmountMinor: bigint;
  discountExpiresOn: string | null;
  amountValidUntil: string | null;
  ruleVersion: string;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const parts = d.toISOString().split("T");
  return parts[0] as string;
}

function roundToNearest(amount: bigint, nearest: bigint): bigint {
  if (nearest <= 0n) return amount;
  const half = nearest / 2n;
  return ((amount + half) / nearest) * nearest;
}

export function computeDerived(input: ComputeDerivedInput): ComputeDerivedResult {
  const { principalMinor, otherLinesMinor, issueDate, dueDate, asOfDate, surchargeRule, earlyDiscountRule, roundingRule } = input;

  // --- Surcharge: DAILY_SIMPLE from due_date, capped, never negative ---
  let surchargeAccruedMinor = 0n;
  if (surchargeRule) {
    const overdueDays = daysBetween(dueDate, asOfDate) - surchargeRule.grace_days;
    if (overdueDays > 0) {
      // rate_pct_per_annum / 100 / 365 * principal * days, kept in integer paisa
      // via a single multiply-then-divide (no float in the money path).
      const rateBpsPerDay = BigInt(Math.round(surchargeRule.rate_pct_per_annum * 100)); // basis points (1% = 100 bps)
      const raw = (principalMinor * rateBpsPerDay * BigInt(overdueDays)) / (10_000n * 365n);
      const cap = (principalMinor * BigInt(Math.round(surchargeRule.max_pct_of_principal * 100))) / 10_000n;
      const capped = raw > cap ? cap : raw;
      surchargeAccruedMinor = roundToNearest(capped, BigInt(surchargeRule.round_to_minor || 1));
    }
  }

  // --- Early discount: live iff today <= issue_date + valid_until.days ---
  let discountAppliedMinor = 0n;
  let discountExpiresOn: string | null = null;
  if (earlyDiscountRule) {
    discountExpiresOn = addDays(issueDate, earlyDiscountRule.valid_until.days);
    const isLive = daysBetween(discountExpiresOn, asOfDate) <= 0;
    if (isLive) {
      discountAppliedMinor = (principalMinor * BigInt(Math.round(earlyDiscountRule.value_pct * 100))) / 10_000n;
    }
  }

  // --- Assemble, then apply the rounding rule to the final payable figure ---
  let payableAmountMinor = principalMinor + otherLinesMinor + surchargeAccruedMinor - discountAppliedMinor;
  if (roundingRule === "NEAREST_1") {
    payableAmountMinor = roundToNearest(payableAmountMinor, 100n); // nearest whole PKR = nearest 100 paisa
  }

  // amount_valid_until: the date beyond which surcharge accrual would change the
  // amount again — the day after `asOfDate`, since accrual is daily.
  const amountValidUntil = surchargeRule ? addDays(asOfDate, 1) : null;

  return {
    surchargeAccruedMinor,
    discountAppliedMinor,
    payableAmountMinor,
    discountExpiresOn,
    amountValidUntil,
    ruleVersion: COMPUTE_DERIVED_RULE_VERSION,
  };
}
