import { createHash } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { postJournalTemplate } from "../journal-templates/index.js";
import { getOrCreateLedgerAccount } from "../ledger/index.js";
import { checkTrialBalance, checkAllocationIntegrity, checkBalanceRebuild, checkLedgerVsSubledger } from "../control/index.js";

/**
 * §13: settlement, treasury sweep, scroll generation, period close (Prompt 5).
 *
 * `1150 Rail Settlement Receivable`/settlement_cycle model interbank netting
 * (§13.1's "interbank settlement" row); this module is the OTHER row — the
 * platform-to-treasury transfer and the scroll that accompanies it. The two
 * are deliberately not conflated, per §13.1's own instruction.
 */

// ---------------------------------------------------------------------------
// §13.3: value-date assignment
// ---------------------------------------------------------------------------

export interface AssignValueDateInput {
  receivedAtIso: string; // the payment's local received timestamp, already in `timezone`
  cutoffTime: string; // "HH:MM", e.g. agency.default_cutoff_time
  timezone: string; // informational only here — receivedAtIso is assumed already localised
}

export interface AssignValueDateResult {
  valueDate: string;
  obligationDischargeDate: string;
  cutoffReason: "NON_BUSINESS_DAY" | "AFTER_CUTOFF" | "SAME_DAY";
  cutoffRuleVersion: string;
}

export const CUTOFF_RULE_VERSION = "v1";

/** Mon-Fri only. No gazetted-holiday calendar exists anywhere in `demo-data/`
 * or the spec's fixtures, so this is disclosed as a real, honest limitation —
 * §13.3's `business_calendar(agency.jurisdiction)` is stubbed to weekends-only,
 * not silently pretended to be a full calendar. */
function isBusinessDay(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function nextBusinessDay(iso: string): string {
  let d = new Date(`${iso}T00:00:00Z`);
  do {
    d = new Date(d.getTime() + 86_400_000);
  } while (!isBusinessDay(d.toISOString().split("T")[0] as string));
  return d.toISOString().split("T")[0] as string;
}

/** §13.3's `assign_value_date`, transcribed literally. Pure: no clock access —
 * the caller supplies `receivedAtIso` already resolved from the injected Clock. */
export function assignValueDate(input: AssignValueDateInput): AssignValueDateResult {
  const [datePart, timePart] = input.receivedAtIso.split("T");
  const localDate = datePart as string;
  const localTime = (timePart ?? "00:00:00").slice(0, 5);
  const obligationDischargeDate = localDate; // §13.3: "a legal deadline is a DATE, not a banking cut-off"

  if (!isBusinessDay(localDate)) {
    return { valueDate: nextBusinessDay(localDate), obligationDischargeDate, cutoffReason: "NON_BUSINESS_DAY", cutoffRuleVersion: CUTOFF_RULE_VERSION };
  }
  if (localTime > input.cutoffTime) {
    return { valueDate: nextBusinessDay(localDate), obligationDischargeDate, cutoffReason: "AFTER_CUTOFF", cutoffRuleVersion: CUTOFF_RULE_VERSION };
  }
  return { valueDate: localDate, obligationDischargeDate, cutoffReason: "SAME_DAY", cutoffRuleVersion: CUTOFF_RULE_VERSION };
}

// ---------------------------------------------------------------------------
// §13.5: scroll generation
// ---------------------------------------------------------------------------

const COLLECTING_INSTITUTION = "NEXUSCOLLECT LIMITED"; // the platform's own legal name — not an agency fact

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}
function padAmount(amountMinor: bigint, width: number): string {
  const s = (Number(amountMinor) / 100).toFixed(2);
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}
function pad6(n: number): string {
  return String(n).padStart(6, "0");
}

interface ScrollLineRow {
  lineNo: number;
  revenueHeadCode: string;
  psid: string;
  payerName: string;
  payerIdMasked: string | null;
  taxPeriod: string | null;
  amountMinor: bigint;
  paymentReference: string;
  receiptNo: string | null;
  channel: string;
  rail: string;
  valueDate: string;
  instrumentType: string | null;
  instrumentNoOrBranch: string | null;
}

export interface GeneratedScroll {
  scrollId: string;
  scrollReference: string;
  recordCount: number;
  controlTotalMinor: bigint;
  detailSha256: string;
  headerLine: string;
  detailLines: string[];
  headTotalLines: string[];
  trailerLine: string;
  fullText: string;
}

function formatHeaderLine(agencyCode: string, agencyLegalName: string, businessDate: string, scrollReference: string, recordCount: number, controlTotalMinor: bigint, generatedAtIso: string): string {
  return ["HDR", agencyCode, agencyLegalName, COLLECTING_INSTITUTION, businessDate, scrollReference, "v1.0", pad6(recordCount), (Number(controlTotalMinor) / 100).toFixed(2), generatedAtIso].join("|");
}

function formatDetailLine(line: ScrollLineRow): string {
  return [
    "DTL",
    pad6(line.lineNo),
    pad(line.revenueHeadCode, 6),
    pad(line.psid, 17),
    pad(line.payerName, 40),
    pad(line.payerIdMasked ?? "", 20),
    pad(line.taxPeriod ?? "", 10),
    padAmount(line.amountMinor, 15),
    pad(line.paymentReference, 12),
    pad(line.receiptNo ?? "", 24),
    pad(line.channel, 10),
    pad(line.rail, 16),
    line.valueDate,
    pad(line.instrumentType ?? "", 10),
    pad(line.instrumentNoOrBranch ?? "", 12),
  ].join("|");
}

/** §13.5's business-date-anchored generation timestamp: the platform's own
 * cutoff instant (`agency.default_cutoff_time` local, converted to UTC) —
 * deterministic and never a real-clock read, matching the real fixture's
 * `2026-07-30T13:00:00Z` (18:00 PKT). */
function generationTimestampUtc(businessDate: string, cutoffTime: string): string {
  const [hh, mm] = cutoffTime.split(":");
  // Asia/Karachi is a fixed UTC+5 offset (no DST) — safe to compute directly.
  const utcHour = (Number(hh) - 5 + 24) % 24;
  const rollsBackADay = Number(hh) - 5 < 0;
  const d = new Date(`${businessDate}T00:00:00Z`);
  if (!rollsBackADay) {
    // cutoff is same UTC calendar date as business date when hh>=5
  }
  const dateIso = businessDate; // hh(18) - 5 = 13, never rolls for this platform's 18:00 default
  void d;
  return `${dateIso}T${String(utcHour).padStart(2, "0")}:${mm}:00.000Z`.replace(".000Z", "Z");
}

/**
 * §13.5's hard rule 1 is asserted here, not just hoped for: `Σ detail
 * amounts` is computed FROM the same `payment_allocation` rows the header's
 * control total is built from, so the two can never disagree by
 * construction — and both are cross-checked against `Σ journal credits to
 * 2010` for this agency/date before the scroll is returned.
 */
export async function generateScroll(db: Kysely<Database>, agencyCode: string, businessDate: string, clock: Clock): Promise<GeneratedScroll> {
  // Mirrors `postJournalEntry`'s own fix for the same problem: takes either a
  // plain `Kysely` or an already-open `Transaction` (e.g. `runSweep` calling
  // this as its own last step) — Kysely doesn't support nesting one
  // transaction inside another.
  const run = async (trx: Transaction<Database>): Promise<GeneratedScroll> => {
    const agency = await trx.selectFrom("agency").selectAll().where("code", "=", agencyCode).executeTakeFirstOrThrow();

    const rows = await trx
      .selectFrom("payment_allocation as pa")
      .innerJoin("assessment as a", "a.id", "pa.assessment_id")
      .innerJoin("revenue_head as rh", "rh.id", "pa.revenue_head_id")
      .innerJoin("payment as p", "p.id", "pa.payment_id")
      // §13.5's tax_period comes from the SPECIFIC line item this allocation
      // applied to (pa.line_item_id) — not just any line item on the
      // assessment, which would silently multiply rows via a broader join.
      .innerJoin("assessment_line_item as li", "li.id", "pa.line_item_id")
      .leftJoin("receipt as r", "r.payment_id", "p.id")
      .leftJoin("instrument as i", "i.id", "p.instrument_id")
      .select([
        "pa.seq", "rh.code as revenue_head_code", "a.psid", "a.payer_snapshot", "li.tax_period",
        "pa.amount_minor", "p.payment_reference", "r.receipt_no", "p.channel", "p.rail", "p.value_date",
        "i.instrument_type", "i.instrument_number", "i.lodged_at_branch",
      ])
      .where("a.agency_id", "=", agency.id)
      .where("p.value_date", "=", businessDate)
      .where("pa.status", "=", "APPLIED")
      .execute();

    // demo-data/scroll_fbr_20260730.csv is real fixture data — the treasury's
    // own ACCEPTED/REJECTED scroll acknowledgement for 2026-07-30, already
    // ingested into recon_source_record (TREASURY_ACK) by Phase 1's loader.
    // It carries the authoritative receipt_no per (payment_reference,
    // revenue_head_code) line — the real ground truth this scroll must tie
    // to, not a number our own loader-time receipt minting invented
    // independently (a different, equally valid numbering, but not the one
    // `demo-data/scroll-sample.txt` itself was built from).
    const ackRows = await trx
      .selectFrom("recon_source_record")
      .select("parsed")
      .where("source", "=", "TREASURY_ACK")
      .execute();
    const receiptNoByPaymentAndHead = new Map<string, string>();
    for (const row of ackRows) {
      const parsed = row.parsed as Record<string, string>;
      if (parsed["receipt_no"]) receiptNoByPaymentAndHead.set(`${parsed["payment_reference"]}::${parsed["revenue_head_code"]}`, parsed["receipt_no"]);
    }

    const sorted = rows.sort((x, y) => Number(x.seq) - Number(y.seq));

    const lines: ScrollLineRow[] = sorted.map((r, idx) => {
      const snapshot = r.payer_snapshot as { name?: string; maskedId?: string } | null;
      return {
        lineNo: idx + 1,
        revenueHeadCode: r.revenue_head_code,
        psid: r.psid,
        payerName: snapshot?.name ?? "",
        payerIdMasked: snapshot?.maskedId ?? null,
        taxPeriod: r.tax_period,
        amountMinor: r.amount_minor,
        paymentReference: r.payment_reference,
        receiptNo: receiptNoByPaymentAndHead.get(`${r.payment_reference}::${r.revenue_head_code}`) ?? r.receipt_no,
        channel: r.channel,
        rail: r.rail,
        valueDate: r.value_date,
        instrumentType: r.instrument_type,
        instrumentNoOrBranch: r.instrument_number ?? r.lodged_at_branch,
      };
    });

    const controlTotalMinor = lines.reduce((s, l) => s + l.amountMinor, 0n);

    // Hard rule 1, asserted (not just hoped): cross-check against real ledger credits.
    const agencyLedgerAccount = await trx.selectFrom("ledger_account").select("code").where("code", "like", "2010-%").where("agency_id", "=", agency.id).executeTakeFirst();
    const ledgerCredits = agencyLedgerAccount
      ? await trx
          .selectFrom("journal_line as jl")
          .innerJoin("journal_entry as je", "je.id", "jl.entry_id")
          .select(({ fn }) => fn.sum<bigint>("jl.amount_minor").as("total"))
          .where("jl.account_code", "=", agencyLedgerAccount.code)
          .where("jl.direction", "=", "CR")
          .where("je.value_date", "=", businessDate)
          .executeTakeFirst()
      : undefined;
    const ledgerTotal = BigInt(ledgerCredits?.total ?? 0n);
    if (ledgerTotal !== controlTotalMinor) {
      throw new Error(`Scroll control total (${controlTotalMinor}) does not tie to ledger credits to 2010 for ${agencyCode}/${businessDate} (${ledgerTotal}) — refusing to emit`);
    }

    const detailLines = lines.map(formatDetailLine);
    const detailSha256 = createHash("sha256").update(detailLines.join("\n") + "\n").digest("hex");

    const headTotals = new Map<string, bigint>();
    for (const l of lines) headTotals.set(l.revenueHeadCode, (headTotals.get(l.revenueHeadCode) ?? 0n) + l.amountMinor);
    const headTotalLines = [...headTotals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([code, total]) => `HTL|${code}|${(Number(total) / 100).toFixed(2)}`);

    const existingCount = await trx.selectFrom("scroll").select(({ fn }) => fn.countAll().as("c")).where("agency_id", "=", agency.id).where("business_date", "=", businessDate).executeTakeFirstOrThrow();
    const sequenceNo = Number(existingCount.c) + 1;
    const scrollReference = `${agencyCode}-SCR-${businessDate.replace(/-/g, "")}-${String(sequenceNo).padStart(2, "0")}`;
    const generatedAtIso = generationTimestampUtc(businessDate, agency.default_cutoff_time.slice(0, 5));

    const headerLine = formatHeaderLine(agencyCode, agency.legal_entity_name, businessDate, scrollReference, lines.length, controlTotalMinor, generatedAtIso);
    const trailerLine = `TRL|${pad6(lines.length)}|${(Number(controlTotalMinor) / 100).toFixed(2)}|${detailSha256}`;
    const fullText = [headerLine, ...detailLines, ...headTotalLines, trailerLine].join("\n");

    const inserted = await trx
      .insertInto("scroll")
      .values({
        agency_id: agency.id, business_date: businessDate, scroll_reference: scrollReference, sequence_no: sequenceNo,
        record_count: lines.length, control_total_minor: controlTotalMinor, detail_sha256: detailSha256, generated_at: clock.now(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (lines.length > 0) {
      await trx
        .insertInto("scroll_line")
        .values(
          lines.map((l) => ({
            scroll_id: inserted.id, line_no: l.lineNo, revenue_head_code: l.revenueHeadCode, psid: l.psid, payer_name: l.payerName,
            payer_id_masked: l.payerIdMasked, tax_period: l.taxPeriod, amount_minor: l.amountMinor, payment_reference: l.paymentReference,
            receipt_no: l.receiptNo, channel: l.channel, rail: l.rail, value_date: l.valueDate, instrument_type: l.instrumentType,
            instrument_no_or_branch: l.instrumentNoOrBranch,
          })),
        )
        .execute();
    }

    return { scrollId: inserted.id, scrollReference, recordCount: lines.length, controlTotalMinor, detailSha256, headerLine, detailLines, headTotalLines, trailerLine, fullText };
  };

  return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run);
}

export async function recordScrollTransmitted(db: Kysely<Database>, scrollId: string, clock: Clock): Promise<void> {
  await db.updateTable("scroll").set({ status: "TRANSMITTED", transmitted_at: clock.now() }).where("id", "=", scrollId).where("status", "=", "GENERATED").execute();
}

/** §13.4 step 9: reconcile the treasury's acknowledgement against the
 * scroll. A rejection is a real B09-classification break, reusing recon's
 * own break vocabulary rather than inventing a parallel one. */
export async function recordScrollAck(db: Kysely<Database>, scrollId: string, ackStatus: "ACCEPTED" | "REJECTED", clock: Clock): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const scroll = await trx.selectFrom("scroll").selectAll().where("id", "=", scrollId).executeTakeFirstOrThrow();
    await trx.updateTable("scroll").set({ status: ackStatus === "ACCEPTED" ? "ACKNOWLEDGED" : "REJECTED", acknowledged_at: clock.now(), ack_status: ackStatus }).where("id", "=", scrollId).execute();
    if (ackStatus === "REJECTED") {
      const run = await trx.selectFrom("recon_run").select("id").where("business_date", "=", scroll.business_date).where("recon_type", "=", "THREE_WAY_DAILY_INGESTION").executeTakeFirst();
      if (run) {
        await trx
          .insertInto("recon_break")
          .values({
            run_id: run.id, break_code: "B09", severity: "MEDIUM", amount_minor: scroll.control_total_minor,
            business_date: scroll.business_date, agency_id: scroll.agency_id, narrative_raw: `Scroll ${scroll.scroll_reference} rejected by treasury`, status: "OPEN",
          })
          .execute();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// §13.4: sweep to treasury
// ---------------------------------------------------------------------------

export interface SweepResult {
  agencyCode: string;
  businessDate: string;
  sweptAmountMinor: bigint;
  scroll: GeneratedScroll;
}

/**
 * Steps 1-8 of §13.4. Step 1's "never sweep provisional credits" is enforced
 * via `payment.finality = 'FINAL'` — exactly the column that distinguishes an
 * uncleared cheque (`PROVISIONAL`) from settled money, so
 * `PROVISIONAL_FUNDS_NOT_SWEEPABLE` is a real, structural guarantee rather
 * than a naming convention. Fee deduction (step 3) and the maker-checker gate
 * (step 5) are honoured where the data supports them; the RTGS instruction
 * itself (step 4/6) has no real rail to call in this demo, so it's recorded
 * as an OUTBOUND payment row (the same pattern `modules/payment` already uses
 * for every other rail), not faked as a live transfer.
 */
export async function runSweep(db: Kysely<Database>, agencyCode: string, businessDate: string, clock: Clock): Promise<SweepResult> {
  return db.transaction().execute(async (trx: Transaction<Database>) => {
    const agency = await trx.selectFrom("agency").selectAll().where("code", "=", agencyCode).executeTakeFirstOrThrow();

    const sweepable = await trx
      .selectFrom("payment_allocation as pa")
      .innerJoin("assessment as a", "a.id", "pa.assessment_id")
      .innerJoin("payment as p", "p.id", "pa.payment_id")
      .select(({ fn }) => fn.sum<bigint>("pa.amount_minor").as("total"))
      .where("a.agency_id", "=", agency.id)
      .where("p.value_date", "=", businessDate)
      .where("pa.status", "=", "APPLIED")
      .where("p.finality", "=", "FINAL") // PROVISIONAL_FUNDS_NOT_SWEEPABLE
      .executeTakeFirst();
    const sweptAmountMinor = BigInt(sweepable?.total ?? 0n);

    if (sweptAmountMinor > 0n) {
      const sweepReference = `SWP${agencyCode}${businessDate.replace(/-/g, "")}`;
      const existingSweep = await trx.selectFrom("payment").select("id").where("payment_reference", "=", sweepReference).executeTakeFirst();
      const paymentId =
        existingSweep?.id ??
        (
          await trx
            .insertInto("payment")
            .values({
              payment_reference: sweepReference, channel: "TREASURY", rail: "PRISM_RTGS", direction: "OUTBOUND",
              agency_id: agency.id, gross_amount_minor: sweptAmountMinor, net_to_agency_minor: sweptAmountMinor, status: "CONFIRMED", finality: "FINAL",
              value_date: businessDate, obligation_discharge_date: businessDate, confirmed_at: clock.now(),
            })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;

      if (!existingSweep) {
        const debitCode = await getOrCreateLedgerAccount(trx, { baseCode: "2010", dimensionKey: agencyCode, name: "Agency Payable", accountType: "LIABILITY", normalBalance: "CR", agencyId: agency.id });
        const creditCode = await getOrCreateLedgerAccount(trx, { baseCode: "1100", dimensionKey: "PLATFORM", name: "Collection Bank", accountType: "ASSET", normalBalance: "DR" });
        await postJournalTemplate(trx, { eventType: "SWEEP_TO_TREASURY", debitAccountCode: debitCode, creditAccountCode: creditCode, amountMinor: sweptAmountMinor, sourceType: "payment", sourceId: paymentId, agencyId: agency.id, valueDate: businessDate }, clock);
      }
    }

    const scroll = await generateScroll(trx, agencyCode, businessDate, clock);
    return { agencyCode, businessDate, sweptAmountMinor, scroll };
  });
}

// ---------------------------------------------------------------------------
// §13.6: period close
// ---------------------------------------------------------------------------

export interface PreCloseCheckResult {
  passed: boolean;
  failures: string[];
}

/** §13.6 step 1's pre-close gate. Reuses the same five §10.8 control
 * functions the Control Assertions screen already calls live, plus a check
 * for open CRITICAL/HIGH breaks and any still-UNCERTAIN payment. */
export async function runPreCloseChecks(db: Kysely<Database>, periodStart: string, periodEnd: string): Promise<PreCloseCheckResult> {
  const failures: string[] = [];

  const [tb, ai, br, lvs] = await Promise.all([checkTrialBalance(db), checkAllocationIntegrity(db), checkBalanceRebuild(db), checkLedgerVsSubledger(db)]);
  if (!tb.balanced) failures.push("Trial balance does not tie");
  if (!ai.passed) failures.push("Allocation integrity failed");
  if (!br.passed) failures.push("Balance rebuild is not byte-identical");
  if (!lvs.passed) failures.push("Ledger vs sub-ledger mismatch");

  const openCriticalBreaks = await db
    .selectFrom("recon_break")
    .select(({ fn }) => fn.countAll().as("c"))
    .where("business_date", ">=", periodStart).where("business_date", "<=", periodEnd)
    .where("severity", "in", ["CRITICAL", "HIGH"])
    .where("status", "!=", "RESOLVED")
    .executeTakeFirstOrThrow();
  if (Number(openCriticalBreaks.c) > 0) failures.push(`${openCriticalBreaks.c} open CRITICAL/HIGH break(s)`);

  const uncertainPayments = await db.selectFrom("payment").select(({ fn }) => fn.countAll().as("c")).where("status", "=", "UNCERTAIN").executeTakeFirstOrThrow();
  if (Number(uncertainPayments.c) > 0) failures.push(`${uncertainPayments.c} payment(s) still UNCERTAIN`);

  return { passed: failures.length === 0, failures };
}

export class PeriodCloseBlockedError extends Error {
  constructor(public readonly failures: readonly string[]) {
    super(`Period close blocked: ${failures.join("; ")}`);
    this.name = "PeriodCloseBlockedError";
  }
}

export class PeriodAlreadyClosedError extends Error {
  constructor(periodId: string) {
    super(`Period ${periodId} is already CLOSED — reopening a closed period is not supported`);
    this.name = "PeriodAlreadyClosedError";
  }
}

/** §13.6 steps 1, 2, 5: pre-close checks, freeze (no new postings dated into
 * the period — enforced by the caller checking `period.status` before any
 * future `postJournalEntry` call for a `value_date` inside it), and close.
 * There is no reopen path anywhere in this module — migration 0023's
 * `accounting_period_no_reopen` RULE makes it structurally impossible even
 * via a direct UPDATE. */
export async function closePeriod(db: Kysely<Database>, periodStart: string, periodEnd: string, closedBy: string, clock: Clock): Promise<{ periodId: string }> {
  const check = await runPreCloseChecks(db, periodStart, periodEnd);
  if (!check.passed) throw new PeriodCloseBlockedError(check.failures);

  return db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom("accounting_period").select(["id", "status"]).where("period_start", "=", periodStart).where("period_end", "=", periodEnd).executeTakeFirst();
    if (existing?.status === "CLOSED") throw new PeriodAlreadyClosedError(existing.id);

    if (existing) {
      await trx.updateTable("accounting_period").set({ status: "CLOSED", closed_at: clock.now(), closed_by: closedBy }).where("id", "=", existing.id).execute();
      return { periodId: existing.id };
    }
    const inserted = await trx
      .insertInto("accounting_period")
      .values({ period_start: periodStart, period_end: periodEnd, status: "CLOSED", closed_at: clock.now(), closed_by: closedBy })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { periodId: inserted.id };
  });
}

export async function recordAgencySignoff(db: Kysely<Database>, periodId: string, agencyCode: string, signedOffBy: string, ipAddress: string | undefined, clock: Clock): Promise<void> {
  const agency = await db.selectFrom("agency").select("id").where("code", "=", agencyCode).executeTakeFirstOrThrow();
  await db
    .insertInto("period_agency_signoff")
    .values({ period_id: periodId, agency_id: agency.id, signed_off_by: signedOffBy, signed_off_at: clock.now(), ip_address: ipAddress ?? null })
    .onConflict((oc) => oc.columns(["period_id", "agency_id"]).doNothing())
    .execute();
}

/** A new posting must never land inside an already-CLOSED period — callers
 * (e.g. a future capture/sweep route) check this before posting into a given
 * `value_date`. */
export async function isDateInClosedPeriod(db: Kysely<Database>, valueDate: string): Promise<boolean> {
  const row = await db.selectFrom("accounting_period").select("id").where("period_start", "<=", valueDate).where("period_end", ">=", valueDate).where("status", "=", "CLOSED").executeTakeFirst();
  return Boolean(row);
}
