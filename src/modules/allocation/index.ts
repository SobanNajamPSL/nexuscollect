/**
 * §11.3's allocation engine, plus §11.4's residual-handling decision table.
 * Pure and synchronous over an in-memory snapshot of open line items — no DB
 * access inside (mirrors `compute-derived.ts`'s style), so it's trivially
 * unit-testable and the P260000E golden proof can call it directly with real
 * numbers without spinning up Postgres.
 *
 * PRO_RATA's exact algorithm is NOT specified anywhere in the spec (confirmed
 * by an exhaustive grep — only PROMPTS.md names "true PRO_RATA with
 * largest-remainder distribution"). This implements the standard Hare-quota
 * largest-remainder method: floor-divide each line's proportional share, then
 * distribute the leftover paisa one at a time to the largest remainders,
 * tie-broken deterministically by `allocationPriority` then `lineItemId` so
 * results are reproducible and golden-file-testable. Disclosed as a sound,
 * standard choice filling a genuine spec gap — not an invented spec fact.
 */

export type LineType = "PRINCIPAL" | "SURCHARGE" | "PENALTY" | "INTEREST" | "FEE" | "TAX_ON_FEE" | "ROUNDING" | "ARREAR";
export type Waterfall = "PENALTY_FIRST" | "PRINCIPAL_FIRST" | "OLDEST_FIRST" | "PRO_RATA" | "EXPLICIT_ONLY";

export interface OpenLine {
  lineItemId: string;
  assessmentId: string;
  lineType: LineType;
  taxPeriod: string | null;
  allocationPriority: number;
  /** amount_minor - allocated_minor as of the start of this allocation call; must be > 0 to be "open". */
  balanceMinor: bigint;
}

export interface ExplicitInstruction {
  lineItemId: string;
  amountMinor: bigint;
}

export interface AllocationDelta {
  lineItemId: string;
  assessmentId: string;
  amountMinor: bigint;
  basis: "EXPLICIT" | "WATERFALL";
}

export interface WaterfallResult {
  allocations: AllocationDelta[];
  /** What's left after explicit instructions + the waterfall/PRO_RATA fill — becomes unapplied. */
  remainingMinor: bigint;
}

// §11.3: order the greedy-fill comparator visits line types in, for the two
// named non-chronological waterfalls. OLDEST_FIRST sorts by tax_period
// instead (below); PRO_RATA and EXPLICIT_ONLY don't use a line-type order at all.
const LINE_TYPE_ORDER: Record<"PENALTY_FIRST" | "PRINCIPAL_FIRST", readonly LineType[]> = {
  PENALTY_FIRST: ["FEE", "PENALTY", "SURCHARGE", "INTEREST", "PRINCIPAL", "TAX_ON_FEE", "ROUNDING", "ARREAR"],
  PRINCIPAL_FIRST: ["PRINCIPAL", "INTEREST", "SURCHARGE", "PENALTY", "FEE", "TAX_ON_FEE", "ROUNDING", "ARREAR"],
};

function sortOpenLines(waterfall: Waterfall, lines: readonly OpenLine[]): OpenLine[] {
  if (waterfall === "OLDEST_FIRST") {
    return [...lines].sort((a, b) => (a.taxPeriod ?? "").localeCompare(b.taxPeriod ?? "") || a.allocationPriority - b.allocationPriority);
  }
  const order = waterfall === "PENALTY_FIRST" || waterfall === "PRINCIPAL_FIRST" ? LINE_TYPE_ORDER[waterfall] : null;
  if (!order) return [...lines]; // PRO_RATA / EXPLICIT_ONLY: caller doesn't use this ordering
  return [...lines].sort((a, b) => order.indexOf(a.lineType) - order.indexOf(b.lineType) || a.allocationPriority - b.allocationPriority);
}

function minBig(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a < b ? a : b));
}

/** Hare-quota largest-remainder distribution: proportional shares, floor-divided,
 * with the leftover paisa handed one at a time to the largest remainders.
 * Asserts (via its own construction) that `sum(allocated) === min(amountMinor, sum(balances))` —
 * no paisa lost, none invented. */
export function applyProRata(openLines: readonly OpenLine[], amountMinor: bigint): AllocationDelta[] {
  const totalBalance = openLines.reduce((s, l) => s + l.balanceMinor, 0n);
  if (totalBalance <= 0n || amountMinor <= 0n) return [];
  const toDistribute = amountMinor < totalBalance ? amountMinor : totalBalance;

  const shares = openLines.map((line) => {
    const numerator = toDistribute * line.balanceMinor;
    return { line, floor: numerator / totalBalance, remainder: numerator % totalBalance };
  });

  const amounts = new Map<string, bigint>(shares.map((s) => [s.line.lineItemId, s.floor]));
  let leftover = toDistribute - shares.reduce((s, x) => s + x.floor, 0n);

  const byLargestRemainder = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.line.allocationPriority !== b.line.allocationPriority) return a.line.allocationPriority - b.line.allocationPriority;
    return a.line.lineItemId < b.line.lineItemId ? -1 : 1;
  });
  for (const s of byLargestRemainder) {
    if (leftover <= 0n) break;
    const current = amounts.get(s.line.lineItemId) ?? 0n;
    if (current >= s.line.balanceMinor) continue; // already at its own cap — never over-allocate a line
    amounts.set(s.line.lineItemId, current + 1n);
    leftover -= 1n;
  }

  return openLines
    .map((line) => ({ lineItemId: line.lineItemId, assessmentId: line.assessmentId, amountMinor: amounts.get(line.lineItemId) ?? 0n, basis: "WATERFALL" as const }))
    .filter((a) => a.amountMinor > 0n);
}

/** §11.3's `apply_waterfall`, implemented literally: explicit instructions
 * first (capped at the line's own balance and what's left of the payment),
 * then — unless `EXPLICIT_ONLY`, which leaves any remainder unapplied — the
 * named waterfall's comparator with a greedy fill, or PRO_RATA's proportional
 * distribution. */
export function applyWaterfall(
  waterfall: Waterfall,
  explicitInstructions: readonly ExplicitInstruction[],
  openLines: readonly OpenLine[],
  amountMinor: bigint,
): WaterfallResult {
  let remaining = amountMinor;
  const allocations: AllocationDelta[] = [];
  const balances = new Map(openLines.map((l) => [l.lineItemId, l.balanceMinor]));
  const byId = new Map(openLines.map((l) => [l.lineItemId, l]));

  for (const instr of explicitInstructions) {
    if (remaining <= 0n) break;
    const line = byId.get(instr.lineItemId);
    if (!line) continue;
    const bal = balances.get(line.lineItemId) ?? 0n;
    const amt = minBig(instr.amountMinor, remaining, bal);
    if (amt > 0n) {
      allocations.push({ lineItemId: line.lineItemId, assessmentId: line.assessmentId, amountMinor: amt, basis: "EXPLICIT" });
      balances.set(line.lineItemId, bal - amt);
      remaining -= amt;
    }
  }

  if (waterfall === "EXPLICIT_ONLY" || remaining <= 0n) {
    return { allocations, remainingMinor: remaining };
  }

  const stillOpen = openLines.map((l) => ({ ...l, balanceMinor: balances.get(l.lineItemId) ?? 0n })).filter((l) => l.balanceMinor > 0n);

  if (waterfall === "PRO_RATA") {
    const proRata = applyProRata(stillOpen, remaining);
    allocations.push(...proRata);
    remaining -= proRata.reduce((s, a) => s + a.amountMinor, 0n);
    return { allocations, remainingMinor: remaining };
  }

  for (const line of sortOpenLines(waterfall, stillOpen)) {
    if (remaining <= 0n) break;
    const bal = balances.get(line.lineItemId) ?? 0n;
    if (bal <= 0n) continue;
    const amt = remaining < bal ? remaining : bal;
    allocations.push({ lineItemId: line.lineItemId, assessmentId: line.assessmentId, amountMinor: amt, basis: "WATERFALL" });
    balances.set(line.lineItemId, bal - amt);
    remaining -= amt;
  }

  return { allocations, remainingMinor: remaining };
}

// --- §11.4 residual handling: per-assessment settle/partial/hold/overpay decision ---

export interface AssessmentSettleInput {
  /** The assessment's live payable_amount_minor (derived, as of this payment). */
  payableAmountMinor: bigint;
  /** Total allocated to this assessment after this payment's own deltas are added in. */
  allocatedAfterMinor: bigint;
  underpayToleranceMinor: bigint;
  overpayToleranceMinor: bigint;
  allowPartial: boolean;
  /** `collection_product.underpay_policy` — which of §11.4's two documented
   * behaviours applies when `allow_partial=false` and the tolerance isn't met. */
  underpayPolicy: "HOLD_AS_UNAPPLIED" | "REJECT_AND_RETURN";
  overpayTreatment: "REJECT" | "CREDIT_ON_ACCOUNT" | "AUTO_REFUND" | "ABSORB";
}

export type AssessmentSettleDecision =
  | { kind: "SETTLED"; roundingReliefMinor: bigint }
  | { kind: "PARTIALLY_PAID" }
  /** §11.4: "never silently keep money against an unsettled bill with no record." */
  | { kind: "HOLD_AS_UNAPPLIED" }
  | { kind: "REJECT_AND_RETURN" }
  | { kind: "OVERPAID"; surplusMinor: bigint; treatment: "ABSORB" | "CREDIT_ON_ACCOUNT" | "AUTO_REFUND" | "REJECT" };

/** §11.3 "SUBTLETY 1": checked per assessment, never against the payment total —
 * "or a payment across two bills can wrongly settle both." */
export function decideAssessmentOutcome(input: AssessmentSettleInput): AssessmentSettleDecision {
  const balanceAfter = input.payableAmountMinor - input.allocatedAfterMinor;

  if (balanceAfter < 0n) {
    const surplus = -balanceAfter;
    return surplus <= input.overpayToleranceMinor
      ? { kind: "OVERPAID", surplusMinor: surplus, treatment: "ABSORB" }
      : { kind: "OVERPAID", surplusMinor: surplus, treatment: input.overpayTreatment };
  }
  if (balanceAfter <= input.underpayToleranceMinor) {
    return { kind: "SETTLED", roundingReliefMinor: balanceAfter };
  }
  if (input.allowPartial) return { kind: "PARTIALLY_PAID" };
  return input.underpayPolicy === "REJECT_AND_RETURN" ? { kind: "REJECT_AND_RETURN" } : { kind: "HOLD_AS_UNAPPLIED" };
}
