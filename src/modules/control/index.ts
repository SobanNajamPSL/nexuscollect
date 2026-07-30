import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { rebuildAssessmentBalance } from "../obligation/index.js";
import { verifyLedgerChain } from "../ledger/index.js";

/**
 * §10.8's five control assertions, each "run on a schedule, surface pass/fail
 * on the ops dashboard, and page on failure." Backs the 5 `/internal/control/*`
 * + `/internal/ledger/verify-chain` endpoints.
 */

export interface TrialBalanceResult {
  balanced: boolean;
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
  date: string | null;
}

/** §10.8: "SUM(DR) = SUM(CR) across all accounts." Scoped to one business
 * date when given (the gate's "on every business date in the dataset" is
 * meant to be run once per date), or the whole ledger when omitted. */
export async function checkTrialBalance(db: Kysely<Database>, date?: string): Promise<TrialBalanceResult> {
  let query = db.selectFrom("journal_line").innerJoin("journal_entry", "journal_entry.id", "journal_line.entry_id").select(["journal_line.direction", "journal_line.amount_minor"]);
  if (date) query = query.where("journal_entry.value_date", "=", date);
  const rows = await query.execute();

  const totalDebitMinor = rows.filter((r) => r.direction === "DR").reduce((s, r) => s + r.amount_minor, 0n);
  const totalCreditMinor = rows.filter((r) => r.direction === "CR").reduce((s, r) => s + r.amount_minor, 0n);

  return { balanced: totalDebitMinor === totalCreditMinor, totalDebitMinor, totalCreditMinor, date: date ?? null };
}

export interface AllocationIntegrityBreak {
  paymentReference: string;
  grossAmountMinor: bigint;
  appliedMinor: bigint;
  unappliedMinor: bigint;
  differenceMinor: bigint;
}

export interface AllocationIntegrityResult {
  passed: boolean;
  breaks: AllocationIntegrityBreak[];
  checkedCount: number;
  /** §10.8: "the control must state its exclusion set explicitly rather than
   * silently skipping rows" — REVERSED/UNCERTAIN payments are excluded by
   * design (a reversed payment's allocations are gone by definition; an
   * UNCERTAIN payment "has not yet been applied at all"). */
  excludedStatuses: readonly string[];
}

/** §10.8: "For every payment in a live state (CONFIRMED, PARTIALLY_REVERSED):
 * Σ applied allocations + unapplied = gross." */
export async function checkAllocationIntegrity(db: Kysely<Database>): Promise<AllocationIntegrityResult> {
  const excludedStatuses = ["REVERSED", "UNCERTAIN"] as const;
  const payments = await db.selectFrom("payment").select(["id", "payment_reference", "gross_amount_minor", "unapplied_amount_minor"]).where("status", "in", ["CONFIRMED", "PARTIALLY_REVERSED"]).execute();

  const breaks: AllocationIntegrityBreak[] = [];
  for (const payment of payments) {
    const applied = await db.selectFrom("payment_allocation").select("amount_minor").where("payment_id", "=", payment.id).where("status", "=", "APPLIED").execute();
    const appliedMinor = applied.reduce((s, a) => s + a.amount_minor, 0n);
    const total = appliedMinor + payment.unapplied_amount_minor;
    if (total !== payment.gross_amount_minor) {
      breaks.push({ paymentReference: payment.payment_reference, grossAmountMinor: payment.gross_amount_minor, appliedMinor, unappliedMinor: payment.unapplied_amount_minor, differenceMinor: payment.gross_amount_minor - total });
    }
  }

  return { passed: breaks.length === 0, breaks, checkedCount: payments.length, excludedStatuses };
}

export interface BalanceRebuildResult {
  passed: boolean;
  checkedCount: number;
  breaks: { assessmentId: string; psid: string }[];
}

/** §10.8: "Recomputed assessment balances byte-identical to cached." Runs
 * `rebuildAssessmentBalance` (modules/obligation) across every assessment. */
export async function checkBalanceRebuild(db: Kysely<Database>): Promise<BalanceRebuildResult> {
  const assessments = await db.selectFrom("assessment").select(["id", "psid"]).execute();
  const breaks: { assessmentId: string; psid: string }[] = [];
  for (const a of assessments) {
    const rebuilt = await rebuildAssessmentBalance(db, a.id);
    if (!rebuilt.matches) breaks.push({ assessmentId: a.id, psid: a.psid });
  }
  return { passed: breaks.length === 0, checkedCount: assessments.length, breaks };
}

export interface LedgerVsSubledgerBreak {
  agencyCode: string;
  ledgerBalanceMinor: bigint;
  subledgerBalanceMinor: bigint;
  differenceMinor: bigint;
}

export interface LedgerVsSubledgerResult {
  passed: boolean;
  breaks: LedgerVsSubledgerBreak[];
  checkedAgencyCount: number;
}

/** §10.8: "2010 (Agency Payable) per agency = Σ unswept allocations per
 * agency." No sweep mechanism exists yet (Phase 5's treasury slice) — every
 * currently-APPLIED allocation is "unswept" in this build, so the subledger
 * side is simply the full applied-allocation total per agency. */
export async function checkLedgerVsSubledger(db: Kysely<Database>): Promise<LedgerVsSubledgerResult> {
  const agencyAccounts = await db.selectFrom("ledger_account").select(["code", "agency_id"]).where("code", "like", "2010-%").execute();
  const breaks: LedgerVsSubledgerBreak[] = [];

  for (const account of agencyAccounts) {
    if (!account.agency_id) continue;
    const agency = await db.selectFrom("agency").select("code").where("id", "=", account.agency_id).executeTakeFirstOrThrow();

    const lines = await db.selectFrom("journal_line").select(["direction", "amount_minor"]).where("account_code", "=", account.code).execute();
    const ledgerBalanceMinor = lines.reduce((s, l) => s + (l.direction === "CR" ? l.amount_minor : -l.amount_minor), 0n);

    const allocations = await db
      .selectFrom("payment_allocation")
      .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
      .select("payment_allocation.amount_minor")
      .where("assessment.agency_id", "=", account.agency_id)
      .where("payment_allocation.status", "=", "APPLIED")
      .execute();
    const subledgerBalanceMinor = allocations.reduce((s, a) => s + a.amount_minor, 0n);

    if (ledgerBalanceMinor !== subledgerBalanceMinor) {
      breaks.push({ agencyCode: agency.code, ledgerBalanceMinor, subledgerBalanceMinor, differenceMinor: ledgerBalanceMinor - subledgerBalanceMinor });
    }
  }

  return { passed: breaks.length === 0, breaks, checkedAgencyCount: agencyAccounts.length };
}

export { verifyLedgerChain };
