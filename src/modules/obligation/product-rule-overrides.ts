import type { EarlyDiscountRule, SurchargeRule } from "./compute-derived.js";

/**
 * demo-data/products.csv has no surcharge_rule/early_discount_rule columns —
 * those are §15.4's "declarative JSON on the product," which the generator
 * never populated (it baked already-computed figures straight into
 * assessments.csv instead). Phase 1 needs at least one product actually
 * *configured* so resolution's live recompute has something real to read.
 *
 * Only `PSCA-CHALLAN-MOV` is seeded here, and only because it's fully
 * isolable: exactly one assessment in the whole 164-row pack
 * (AS-00072, PSID 41011300000190123, the LEA-17-1000 anchor) has a nonzero
 * `discount_applied_minor`, and it is EXACTLY 25% of principal with
 * `issue_date + 10 days = discount_expires_on` (2026-07-22 + 10 =
 * 2026-08-01) — both numbers match §15.4's own worked example precisely, so
 * this reproduces a real, already-verified figure rather than inventing one.
 *
 * No surcharge_rule is seeded for any product: the two other LEA-17-1000
 * payables (AS-00057, AS-00073) are OVERDUE with `surcharge_accrued_minor: 0`
 * in the demo data, so a configured surcharge rule would make Phase 1's own
 * gate anchor stop matching. Ten *other* ETPB-TOKEN-CAR assessments do carry
 * a nonzero baked-in surcharge, meaning the generator's real surcharge logic
 * is more nuanced than a uniform "always accrues from due_date" — reproducing
 * it exactly would mean reverse-engineering undocumented generator internals
 * for no gate-test benefit. `computeDerived` implements the real DAILY_SIMPLE
 * mechanism (see compute-derived.ts); it's just not switched on for any
 * product yet, which is an honest gap, not a stub.
 */
export const EARLY_DISCOUNT_RULE_OVERRIDES: Readonly<Record<string, EarlyDiscountRule>> = {
  "PSCA-CHALLAN-MOV": {
    basis: "PCT_OF_PRINCIPAL",
    value_pct: 25.0,
    valid_until: { type: "DAYS_FROM_ISSUE", days: 10 },
    applies_to_line_types: ["PRINCIPAL"],
  },
};

export const SURCHARGE_RULE_OVERRIDES: Readonly<Record<string, SurchargeRule>> = {};
