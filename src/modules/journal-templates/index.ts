import type { Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { postJournalEntry, type JournalLineInput } from "../ledger/index.js";

/**
 * §10.6's 30 journal templates, "implement it literally as configuration,
 * keyed by `event_type`, and test each template with a golden-file
 * assertion." `JOURNAL_TEMPLATES` is that literal table — each entry names
 * its base debit/credit account codes exactly as §10.3/10.6 state them.
 *
 * Several base codes carry a per-dimension placeholder ({agency}/{rail}/
 * {bank}/{branch}) that only becomes a real account code once the caller
 * resolves it via `getOrCreateLedgerAccount` (modules/ledger) — that
 * resolution is the caller's job (it knows which agency/rail/bank this
 * specific posting is for), not this table's. `postJournalTemplate` posts
 * exactly one template as a balanced 2-line entry; §10.7's worked example
 * (several templates merged into one entry, e.g. collection + fee + tax-on-fee)
 * is composed by the caller via `combineTemplateLines`.
 */
export type JournalTemplateEventType =
  | "COLLECT_RAIL_CONFIRMED" | "RAIL_CYCLE_SETTLED" | "COLLECT_PASS_THROUGH" | "COLLECT_CASH_OTC"
  | "CASH_DEPOSITED_TO_BANK" | "CHEQUE_LODGED" | "CHEQUE_PRESENTED" | "CHEQUE_CLEARED"
  | "PROVISIONAL_TO_FINAL" | "CHEQUE_RETURNED" | "RECEIPT_UNAPPLIED" | "UNAPPLIED_ALLOCATED"
  | "OVERPAYMENT_RECOGNISED" | "FEE_CHARGED_PAYER" | "FEE_DEDUCTED_FROM_AGENCY" | "TAX_ON_FEE"
  | "CHANNEL_COMMISSION" | "SWEEP_TO_TREASURY" | "REFUND_APPROVED" | "REFUND_PAID"
  | "PAYMENT_REVERSED" | "CHARGEBACK_DEBITED" | "TILL_OVER" | "TILL_SHORT" | "RECON_WRITE_OFF"
  | "DEPOSIT_RECEIVED" | "DEPOSIT_REFUNDED" | "DEPOSIT_FORFEITED" | "UNAPPLIED_AGED_TO_UNCLAIMED"
  | "DISHONOUR_CHARGE_COLLECTED";

export interface JournalTemplateDef {
  /** T01-T30, kept only for doc/traceability — not read by any code path. */
  templateNo: string;
  debitBaseCode: string;
  debitName: string;
  creditBaseCode: string;
  creditName: string;
  /** §10.6 note: requires `approval_id` to be set (e.g. manual unapplied-allocation, write-off). */
  requiresApproval?: boolean;
}

export const JOURNAL_TEMPLATES: Record<JournalTemplateEventType, JournalTemplateDef> = {
  COLLECT_RAIL_CONFIRMED: { templateNo: "T01", debitBaseCode: "1150", debitName: "Rail Settlement Receivable", creditBaseCode: "2010", creditName: "Agency Payable" },
  RAIL_CYCLE_SETTLED: { templateNo: "T02", debitBaseCode: "1100", debitName: "Collection Bank", creditBaseCode: "1150", creditName: "Rail Settlement Receivable" },
  COLLECT_PASS_THROUGH: { templateNo: "T03", debitBaseCode: "9001", debitName: "Pass-Through Memo (Dr)", creditBaseCode: "9002", creditName: "Pass-Through Memo (Cr)" },
  COLLECT_CASH_OTC: { templateNo: "T04", debitBaseCode: "1010", debitName: "Cash in Till", creditBaseCode: "2010", creditName: "Agency Payable" },
  CASH_DEPOSITED_TO_BANK: { templateNo: "T05", debitBaseCode: "1100", debitName: "Collection Bank", creditBaseCode: "1010", creditName: "Cash in Till" },
  CHEQUE_LODGED: { templateNo: "T06", debitBaseCode: "1020", debitName: "Cheques in Hand", creditBaseCode: "2015", creditName: "Agency Payable (Provisional)" },
  CHEQUE_PRESENTED: { templateNo: "T07", debitBaseCode: "1030", debitName: "Cheques in Clearing", creditBaseCode: "1020", creditName: "Cheques in Hand" },
  CHEQUE_CLEARED: { templateNo: "T08", debitBaseCode: "1100", debitName: "Collection Bank", creditBaseCode: "1030", creditName: "Cheques in Clearing" },
  PROVISIONAL_TO_FINAL: { templateNo: "T09", debitBaseCode: "2015", debitName: "Agency Payable (Provisional)", creditBaseCode: "2010", creditName: "Agency Payable" },
  CHEQUE_RETURNED: { templateNo: "T10", debitBaseCode: "2015", debitName: "Agency Payable (Provisional)", creditBaseCode: "1030", creditName: "Cheques in Clearing" },
  RECEIPT_UNAPPLIED: { templateNo: "T11", debitBaseCode: "1100", debitName: "Collection Bank / Rail Receivable", creditBaseCode: "2020", creditName: "Unapplied Receipts" },
  UNAPPLIED_ALLOCATED: { templateNo: "T12", debitBaseCode: "2020", debitName: "Unapplied Receipts", creditBaseCode: "2010", creditName: "Agency Payable", requiresApproval: true },
  OVERPAYMENT_RECOGNISED: { templateNo: "T13", debitBaseCode: "2010", debitName: "Agency Payable", creditBaseCode: "2030", creditName: "Overpayment Payable" },
  FEE_CHARGED_PAYER: { templateNo: "T14", debitBaseCode: "1150", debitName: "Rail Settlement Receivable (fee portion)", creditBaseCode: "4010", creditName: "Platform Fee Income" },
  FEE_DEDUCTED_FROM_AGENCY: { templateNo: "T15", debitBaseCode: "2010", debitName: "Agency Payable", creditBaseCode: "4010", creditName: "Platform Fee Income" },
  TAX_ON_FEE: { templateNo: "T16", debitBaseCode: "4010", debitName: "Platform Fee Income", creditBaseCode: "2200", creditName: "Tax on Fees Payable" },
  CHANNEL_COMMISSION: { templateNo: "T17", debitBaseCode: "5020", debitName: "Channel Commission Expense", creditBaseCode: "2100", creditName: "Fee Payable to Channel Partner" },
  SWEEP_TO_TREASURY: { templateNo: "T18", debitBaseCode: "2010", debitName: "Agency Payable", creditBaseCode: "1100", creditName: "Collection Bank" },
  REFUND_APPROVED: { templateNo: "T19", debitBaseCode: "2030", debitName: "Overpayment Payable / Agency Payable", creditBaseCode: "2050", creditName: "Refunds Payable" },
  REFUND_PAID: { templateNo: "T20", debitBaseCode: "2050", debitName: "Refunds Payable", creditBaseCode: "1100", creditName: "Collection Bank" },
  PAYMENT_REVERSED: { templateNo: "T21", debitBaseCode: "2010", debitName: "Agency Payable", creditBaseCode: "1150", creditName: "Rail Settlement Receivable / Bank / Till" },
  CHARGEBACK_DEBITED: { templateNo: "T22", debitBaseCode: "2010", debitName: "Agency Payable", creditBaseCode: "1300", creditName: "Card Acquirer Receivable" },
  TILL_OVER: { templateNo: "T23", debitBaseCode: "1010", debitName: "Cash in Till", creditBaseCode: "5900", creditName: "Cash Over/Short" },
  TILL_SHORT: { templateNo: "T24", debitBaseCode: "5900", debitName: "Cash Over/Short", creditBaseCode: "1010", creditName: "Cash in Till" },
  RECON_WRITE_OFF: { templateNo: "T25", debitBaseCode: "5910", debitName: "Recon Write-off", creditBaseCode: "1900", creditName: "Suspense / Unapplied Receipts", requiresApproval: true },
  DEPOSIT_RECEIVED: { templateNo: "T26", debitBaseCode: "1100", debitName: "Collection Bank / Rail Receivable", creditBaseCode: "2040", creditName: "Refundable Deposits" },
  DEPOSIT_REFUNDED: { templateNo: "T27", debitBaseCode: "2040", debitName: "Refundable Deposits", creditBaseCode: "1100", creditName: "Collection Bank" },
  DEPOSIT_FORFEITED: { templateNo: "T28", debitBaseCode: "2040", debitName: "Refundable Deposits", creditBaseCode: "2010", creditName: "Agency Payable" },
  UNAPPLIED_AGED_TO_UNCLAIMED: { templateNo: "T29", debitBaseCode: "2020", debitName: "Unapplied Receipts", creditBaseCode: "2060", creditName: "Unclaimed Funds" },
  DISHONOUR_CHARGE_COLLECTED: { templateNo: "T30", debitBaseCode: "1150", debitName: "Rail Settlement Receivable / Bank", creditBaseCode: "4020", creditName: "Dishonour Charge Income" },
};

export interface PostJournalTemplateInput {
  eventType: JournalTemplateEventType;
  debitAccountCode: string; // resolved by the caller (getOrCreateLedgerAccount for per-dimension codes)
  creditAccountCode: string;
  amountMinor: bigint;
  sourceType: string;
  sourceId: string;
  valueDate: string;
  agencyId?: string;
  revenueHeadId?: string;
  narrative?: string;
  correlationId?: string;
  approvalId?: string;
  sequence?: number;
  dimension?: Record<string, unknown>;
}

/** Posts exactly one template as a balanced 2-line entry. */
export async function postJournalTemplate(
  trx: Transaction<Database>,
  input: PostJournalTemplateInput,
  clock: Clock,
): Promise<{ id: string; entryNo: bigint; replayed: boolean }> {
  const def = JOURNAL_TEMPLATES[input.eventType];
  if (def.requiresApproval && !input.approvalId) {
    throw new Error(`${input.eventType} (${def.templateNo}) requires approval_id`);
  }
  return postJournalEntry(
    trx,
    {
      eventType: input.eventType,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
      ...(input.agencyId !== undefined ? { agencyId: input.agencyId } : {}),
      valueDate: input.valueDate,
      ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      lines: templateLines(input),
    },
    clock,
  );
}

function templateLines(input: PostJournalTemplateInput): JournalLineInput[] {
  return [
    { seq: 1, accountCode: input.debitAccountCode, direction: "DR", amountMinor: input.amountMinor, ...(input.revenueHeadId ? { revenueHeadId: input.revenueHeadId } : {}), ...(input.dimension ? { dimension: input.dimension } : {}) },
    { seq: 2, accountCode: input.creditAccountCode, direction: "CR", amountMinor: input.amountMinor, ...(input.revenueHeadId ? { revenueHeadId: input.revenueHeadId } : {}), ...(input.dimension ? { dimension: input.dimension } : {}) },
  ];
}

/** §10.7's worked example: several templates' legs merged into ONE balanced
 * entry (e.g. collection + fee + tax-on-fee in a single posting) rather than
 * three separate ones. Renumbers `seq` across the combined set. */
export function combineTemplateLines(...inputs: PostJournalTemplateInput[]): JournalLineInput[] {
  let seq = 1;
  const lines: JournalLineInput[] = [];
  for (const input of inputs) {
    for (const line of templateLines(input)) {
      lines.push({ ...line, seq: seq++ });
    }
  }
  return lines;
}
