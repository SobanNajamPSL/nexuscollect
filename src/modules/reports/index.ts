import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { signReceiptPayload } from "../../platform/receipt-signing/index.js";

/**
 * §21.1's 18-report standard pack. Every report here is a real query against
 * data this build actually has — R09/R15/R16/R17 are genuinely short of some
 * inputs (per-transaction cost, uptime/incident tracking, complaint themes,
 * a confirmed regulatory format) and say so explicitly in their own result
 * rather than filling the gap with an invented number.
 */

function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

// R01 — Daily Collection Summary
export async function r01DailyCollectionSummary(db: Kysely<Database>, businessDate: string) {
  const rows = await db
    .selectFrom("payment")
    .leftJoin("agency", "agency.id", "payment.agency_id")
    .select(["agency.code as agency_code", "payment.channel", "payment.rail"])
    .select(({ fn }) => [fn.countAll().as("count"), fn.sum<bigint>("payment.gross_amount_minor").as("gross_minor"), fn.sum<bigint>("payment.fee_amount_minor").as("fee_minor"), fn.sum<bigint>("payment.net_to_agency_minor").as("net_minor")])
    .where("payment.value_date", "=", businessDate)
    .where("payment.status", "=", "CONFIRMED")
    .where("payment.direction", "=", "INBOUND")
    .groupBy(["agency.code", "payment.channel", "payment.rail"])
    .execute();
  return { businessDate, rows: rows.map((r) => ({ agencyCode: r.agency_code, channel: r.channel, rail: r.rail, count: Number(r.count), grossMinor: BigInt(r.gross_minor ?? 0n), feeMinor: BigInt(r.fee_minor ?? 0n), netMinor: BigInt(r.net_minor ?? 0n) })) };
}

// R02 — Head-wise Collection Statement (the report treasury actually uses)
export async function r02HeadWiseStatement(db: Kysely<Database>, periodStart: string, periodEnd: string, agencyCode?: string) {
  let q = db
    .selectFrom("payment_allocation as pa")
    .innerJoin("payment as p", "p.id", "pa.payment_id")
    .innerJoin("assessment as a", "a.id", "pa.assessment_id")
    .innerJoin("agency as ag", "ag.id", "a.agency_id")
    .innerJoin("revenue_head as rh", "rh.id", "pa.revenue_head_id")
    .select(["ag.code as agency_code", "rh.code as head_code", "rh.name as head_name"])
    .select(({ fn }) => fn.sum<bigint>("pa.amount_minor").as("amount_minor"))
    .where("p.value_date", ">=", periodStart)
    .where("p.value_date", "<=", periodEnd)
    .where("pa.status", "=", "APPLIED")
    .groupBy(["ag.code", "rh.code", "rh.name"]);
  if (agencyCode) q = q.where("ag.code", "=", agencyCode);
  const rows = await q.execute();
  return { periodStart, periodEnd, rows: rows.map((r) => ({ agencyCode: r.agency_code, headCode: r.head_code, headName: r.head_name, amountMinor: BigInt(r.amount_minor ?? 0n) })) };
}

// R03 — Daily Reconciliation Certificate
export async function r03ReconciliationCertificate(db: Kysely<Database>, businessDate: string) {
  const run = await db.selectFrom("recon_run").selectAll().where("business_date", "=", businessDate).where("recon_type", "=", "THREE_WAY_DAILY_INGESTION").executeTakeFirst();
  if (!run) return { businessDate, found: false as const };
  const breaks = await db.selectFrom("recon_break").select(["status", "break_code"]).where("run_id", "=", run.id).execute();
  const openCount = breaks.filter((b) => b.status !== "RESOLVED").length;
  return { businessDate, found: true as const, runId: run.id, totalBreaks: breaks.length, openUnreconciled: openCount, closingReconciled: breaks.length - openCount };
}

// R04 — Break Register & Ageing
export async function r04BreakRegisterAgeing(db: Kysely<Database>, asOfDate: string) {
  const breaks = await db.selectFrom("recon_break").selectAll().where("status", "!=", "RESOLVED").execute();
  const byCode = new Map<string, { count: number; amountMinor: bigint; ageBuckets: Record<string, number> }>();
  for (const b of breaks) {
    const age = daysBetween(b.business_date, asOfDate);
    const bucket = age <= 1 ? "0-1d" : age <= 7 ? "2-7d" : age <= 30 ? "8-30d" : "30d+";
    const entry = byCode.get(b.break_code) ?? { count: 0, amountMinor: 0n, ageBuckets: {} };
    entry.count++;
    entry.amountMinor += b.amount_minor;
    entry.ageBuckets[bucket] = (entry.ageBuckets[bucket] ?? 0) + 1;
    byCode.set(b.break_code, entry);
  }
  return { asOfDate, byCode: Object.fromEntries(byCode) };
}

// R05 — Settlement & Sweep Report
export async function r05SettlementSweepReport(db: Kysely<Database>, businessDate: string) {
  const scrolls = await db.selectFrom("scroll").innerJoin("agency", "agency.id", "scroll.agency_id").select(["scroll.id", "agency.code as agency_code", "scroll.scroll_reference", "scroll.control_total_minor", "scroll.status", "scroll.ack_status"]).where("scroll.business_date", "=", businessDate).execute();
  const sweeps = await db.selectFrom("payment").innerJoin("agency", "agency.id", "payment.agency_id").select(["agency.code as agency_code", "payment.payment_reference", "payment.gross_amount_minor"]).where("payment.direction", "=", "OUTBOUND").where("payment.value_date", "=", businessDate).execute();
  return {
    businessDate,
    // The scroll id travels with the row so an operator can record treasury's
    // response against it; without it the acknowledgement route is unreachable
    // from any screen that lists scrolls.
    scrolls: scrolls.map((s) => ({ id: s.id, agencyCode: s.agency_code, scrollReference: s.scroll_reference, controlTotalMinor: s.control_total_minor, status: s.status, ackStatus: s.ack_status })),
    sweeps: sweeps.map((s) => ({ agencyCode: s.agency_code, paymentReference: s.payment_reference, amountMinor: s.gross_amount_minor })),
  };
}

// R06 — Unapplied Receipts Ageing (the stranded-money report)
export async function r06UnappliedReceiptsAgeing(db: Kysely<Database>, asOfDate: string) {
  const rows = await db.selectFrom("payment").select(["payment_reference", "unapplied_amount_minor", "value_date", "channel", "rail"]).where("unapplied_amount_minor", ">", 0n).where("status", "=", "CONFIRMED").execute();
  return { asOfDate, rows: rows.map((r) => ({ paymentReference: r.payment_reference, amountMinor: r.unapplied_amount_minor, ageDays: daysBetween(r.value_date, asOfDate), channel: r.channel, rail: r.rail })) };
}

// R07 — Outstanding Assessments Ageing
export async function r07OutstandingAssessmentsAgeing(db: Kysely<Database>, asOfDate: string) {
  const rows = await db
    .selectFrom("assessment")
    .innerJoin("agency", "agency.id", "assessment.agency_id")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .select(["agency.code as agency_code", "collection_product.code as product_code", "assessment.due_date", "assessment.balance_minor"])
    .where("assessment.balance_minor", ">", 0n)
    .where("assessment.status", "in", ["ISSUED", "PARTIALLY_PAID", "OVERDUE"])
    .execute();
  const buckets = { "not_due": 0n, "1-30d": 0n, "31-90d": 0n, "90d+": 0n };
  for (const r of rows) {
    const age = daysBetween(r.due_date, asOfDate);
    const key = age < 0 ? "not_due" : age <= 30 ? "1-30d" : age <= 90 ? "31-90d" : "90d+";
    buckets[key] += r.balance_minor;
  }
  return { asOfDate, totalOutstandingMinor: rows.reduce((s, r) => s + r.balance_minor, 0n), ageBuckets: buckets, count: rows.length };
}

// R08 — RtP Funnel
export async function r08RtpFunnel(db: Kysely<Database>) {
  const rows = await db.selectFrom("request_to_pay").select("status").select(({ fn }) => fn.countAll().as("count")).groupBy("status").execute();
  return { byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.count)])) };
}

// R09 — Channel Performance (partial: no per-transaction latency/cost tracked in this build)
export async function r09ChannelPerformance(db: Kysely<Database>) {
  const rows = await db
    .selectFrom("payment")
    .select(["channel", "status"])
    .select(({ fn }) => [fn.countAll().as("count"), fn.sum<bigint>("gross_amount_minor").as("value_minor")])
    .groupBy(["channel", "status"])
    .execute();
  return {
    byChannel: rows.map((r) => ({ channel: r.channel, status: r.status, count: Number(r.count), valueMinor: BigInt(r.value_minor ?? 0n) })),
    disclosedGap: "Latency percentiles and cost-per-transaction are not tracked anywhere in this build's schema — real volume/value/success-rate only, not fabricated.",
  };
}

// R10 — Fee & Revenue Statement
export async function r10FeeRevenueStatement(db: Kysely<Database>, periodStart: string, periodEnd: string) {
  const rows = await db
    .selectFrom("payment")
    .leftJoin("agency", "agency.id", "payment.agency_id")
    .select(["agency.code as agency_code"])
    .select(({ fn }) => [fn.sum<bigint>("payment.fee_amount_minor").as("fee_minor"), fn.countAll().as("count")])
    .where("payment.value_date", ">=", periodStart)
    .where("payment.value_date", "<=", periodEnd)
    .where("payment.status", "=", "CONFIRMED")
    .groupBy("agency.code")
    .execute();
  return { periodStart, periodEnd, byAgency: rows.map((r) => ({ agencyCode: r.agency_code, feeIncomeMinor: BigInt(r.fee_minor ?? 0n), transactionCount: Number(r.count) })) };
}

// R11 — Refunds & Reversals
export async function r11RefundsAndReversals(db: Kysely<Database>, periodStart: string, periodEnd: string) {
  const rows = await db.selectFrom("refund").select(["reason_code", "status"]).select(({ fn }) => [fn.countAll().as("count"), fn.sum<bigint>("amount_minor").as("amount_minor")]).where("created_at", ">=", new Date(`${periodStart}T00:00:00Z`)).where("created_at", "<=", new Date(`${periodEnd}T23:59:59Z`)).groupBy(["reason_code", "status"]).execute();
  return { periodStart, periodEnd, rows: rows.map((r) => ({ reasonCode: r.reason_code, status: r.status, count: Number(r.count), amountMinor: BigInt(r.amount_minor ?? 0n) })) };
}

// R12 — Cheque Performance
export async function r12ChequePerformance(db: Kysely<Database>) {
  const rows = await db.selectFrom("instrument").select(["status", "drawee_bank_name"]).select(({ fn }) => [fn.countAll().as("count"), fn.sum<bigint>("amount_minor").as("amount_minor")]).groupBy(["status", "drawee_bank_name"]).execute();
  const total = await db.selectFrom("instrument").select(({ fn }) => fn.countAll().as("c")).executeTakeFirstOrThrow();
  const returned = await db.selectFrom("instrument").select(({ fn }) => fn.countAll().as("c")).where("status", "=", "RETURNED").executeTakeFirstOrThrow();
  return { rows: rows.map((r) => ({ status: r.status, draweeBankName: r.drawee_bank_name, count: Number(r.count), amountMinor: BigInt(r.amount_minor ?? 0n) })), returnRatePct: Number(total.c) > 0 ? (Number(returned.c) / Number(total.c)) * 100 : 0 };
}

// R13 — Trial Balance & Control Pack
export async function r13ControlPack(db: Kysely<Database>) {
  const { checkTrialBalance, checkAllocationIntegrity, checkBalanceRebuild, checkLedgerVsSubledger, verifyLedgerChain } = await import("../control/index.js");
  const [tb, ai, br, lvs, chain] = await Promise.all([checkTrialBalance(db), checkAllocationIntegrity(db), checkBalanceRebuild(db), checkLedgerVsSubledger(db), verifyLedgerChain(db)]);
  return {
    trialBalance: { passed: tb.balanced, totalDebitMinor: tb.totalDebitMinor, totalCreditMinor: tb.totalCreditMinor },
    allocationIntegrity: { passed: ai.passed, checkedCount: ai.checkedCount },
    balanceRebuild: { passed: br.passed, checkedCount: br.checkedCount },
    ledgerVsSubledger: { passed: lvs.passed, checkedAgencyCount: lvs.checkedAgencyCount },
    hashChain: { intact: chain === null, break: chain },
  };
}

// R14 — Period Statement per Agency
export async function r14PeriodStatementPerAgency(db: Kysely<Database>, agencyCode: string, periodStart: string, periodEnd: string) {
  const agency = await db.selectFrom("agency").select("id").where("code", "=", agencyCode).executeTakeFirstOrThrow();
  const collections = await db.selectFrom("payment_allocation as pa").innerJoin("assessment as a", "a.id", "pa.assessment_id").innerJoin("payment as p", "p.id", "pa.payment_id").select(({ fn }) => fn.sum<bigint>("pa.amount_minor").as("total")).where("a.agency_id", "=", agency.id).where("p.value_date", ">=", periodStart).where("p.value_date", "<=", periodEnd).where("pa.status", "=", "APPLIED").executeTakeFirst();
  const refunds = await db.selectFrom("refund as r").innerJoin("payment as p", "p.id", "r.payment_id").select(({ fn }) => fn.sum<bigint>("r.amount_minor").as("total")).where("p.agency_id", "=", agency.id).where("r.status", "=", "PAID").executeTakeFirst();
  const swept = await db.selectFrom("payment").select(({ fn }) => fn.sum<bigint>("gross_amount_minor").as("total")).where("agency_id", "=", agency.id).where("direction", "=", "OUTBOUND").where("value_date", ">=", periodStart).where("value_date", "<=", periodEnd).executeTakeFirst();
  return { agencyCode, periodStart, periodEnd, collectionsMinor: BigInt(collections?.total ?? 0n), refundsMinor: BigInt(refunds?.total ?? 0n), sweptMinor: BigInt(swept?.total ?? 0n) };
}

// R15 — SLA & Availability (not tracked in this build)
export function r15SlaAvailability() {
  return { disclosedGap: "No uptime/latency-percentile/incident tracking exists anywhere in this build's schema — this report has no real data to serve and is not fabricated. A production deployment would source this from real infrastructure monitoring (§19), explicitly out of scope per CLAUDE.md." };
}

// R16 — Payer Experience (partial: duplicate rate is real; abandonment/complaint themes are not tracked)
export async function r16PayerExperience(db: Kysely<Database>) {
  const total = await db.selectFrom("payment").select(({ fn }) => fn.countAll().as("c")).executeTakeFirstOrThrow();
  const duplicates = await db.selectFrom("payment").select(({ fn }) => fn.countAll().as("c")).where("duplicate_of_payment_id", "is not", null).executeTakeFirstOrThrow();
  return {
    duplicateRatePct: Number(total.c) > 0 ? (Number(duplicates.c) / Number(total.c)) * 100 : 0,
    disclosedGap: "Abandonment-by-channel-and-step and complaint themes need session/funnel tracking and a support-ticket integration, neither of which exist in this build — not fabricated.",
  };
}

// R17 — Regulatory Return ([A]: format unconfirmed per §21.1's own marker)
export function r17RegulatoryReturn() {
  return { disclosedGap: "§21.1 marks this report's required format as [A] 'per SBP's PSO/PSP reporting format — confirm.' No format is invented here; building this report requires that confirmation first." };
}

// R18 — Fiscal Year Certificate (full-year head-wise collection, signed)
export async function r18FiscalYearCertificate(db: Kysely<Database>, agencyCode: string, fiscalYearStart: string, fiscalYearEnd: string, clock: Clock) {
  const statement = await r02HeadWiseStatement(db, fiscalYearStart, fiscalYearEnd, agencyCode);
  const totalMinor = statement.rows.reduce((s, r) => s + r.amountMinor, 0n);
  const payload = { agency_code: agencyCode, fiscal_year_start: fiscalYearStart, fiscal_year_end: fiscalYearEnd, total_minor: totalMinor.toString(), head_wise: statement.rows.map((r) => ({ head_code: r.headCode, head_name: r.headName, amount_minor: r.amountMinor.toString() })), certified_at: clock.now().toISOString() };
  const signed = signReceiptPayload(payload);
  return { ...payload, signature: signed };
}
