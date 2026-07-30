import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { Clock } from "../platform/clock/index.js";
import { DemoClock } from "../platform/clock/index.js";
import { loadDemoData } from "./index.js";

/**
 * `POST /internal/demo/reset` (Prompt 4): "restores the seeded state in
 * under 10 seconds." Truncates every business table (schema/reference tables
 * like `ledger_account`'s singular seed rows get re-seeded by migration 0014,
 * untouched here since this never re-runs migrations) and reloads the
 * unmodified `demo-data/` directly, reusing the exact same `loadDemoData`
 * every other environment uses — never a second, drifting seeding path.
 */
const BUSINESS_TABLES = [
  "recon_break", "recon_source_record", "recon_source_file", "recon_run",
  "outbox_event", "audit_log", "journal_line", "journal_entry",
  "receipt", "instrument_link", "instrument", "payment_allocation", "payment", "payment_intent",
  "request_to_pay", "resolution_index", "assessment_line_item", "assessment",
  "payer_account", "payer", "collection_product", "reference_scheme", "revenue_head", "agency",
  "idempotency_record", "approval", "ledger_account",
] as const;

export async function resetDemoData(db: Kysely<Database>, demoDataDir: string, clock: Clock): Promise<void> {
  await sql`SELECT set_config('app.is_platform_role', 'true', true)`.execute(db);
  await sql.raw(`TRUNCATE TABLE ${BUSINESS_TABLES.join(", ")} RESTART IDENTITY CASCADE`).execute(db);

  // Re-seed the singular chart-of-accounts rows migration 0014 originally
  // inserted (this reset truncates ledger_account too, since per-dimension
  // accounts like `2010-FBR` accumulate there at runtime and must go).
  await db
    .insertInto("ledger_account")
    .values([
      { code: "1900", name: "Suspense — Recon Investigation", account_type: "ASSET", normal_balance: "DR" },
      { code: "2020", name: "Unapplied Receipts", account_type: "LIABILITY", normal_balance: "CR" },
      { code: "2050", name: "Refunds Payable", account_type: "LIABILITY", normal_balance: "CR" },
      { code: "2060", name: "Unclaimed Funds", account_type: "LIABILITY", normal_balance: "CR" },
      { code: "2100", name: "Fee Payable to Channel Partner", account_type: "LIABILITY", normal_balance: "CR" },
      { code: "2200", name: "Tax on Fees Payable", account_type: "LIABILITY", normal_balance: "CR" },
      { code: "4010", name: "Platform Fee Income", account_type: "INCOME", normal_balance: "CR" },
      { code: "4020", name: "Dishonour Charge Income", account_type: "INCOME", normal_balance: "CR" },
      { code: "5010", name: "Rail/Scheme Cost", account_type: "EXPENSE", normal_balance: "DR" },
      { code: "5020", name: "Channel Commission Expense", account_type: "EXPENSE", normal_balance: "DR" },
      { code: "5900", name: "Cash Over/Short", account_type: "EXPENSE", normal_balance: "DR" },
      { code: "5910", name: "Recon Write-off", account_type: "EXPENSE", normal_balance: "DR" },
      { code: "3900", name: "Control — Unbalanced Detected", account_type: "EQUITY", normal_balance: "CR" },
    ])
    .execute();

  if (clock instanceof DemoClock) clock.reset();

  await loadDemoData(db, demoDataDir, clock);
}
