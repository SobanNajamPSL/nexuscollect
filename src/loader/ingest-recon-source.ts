import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import type { Clock } from "../platform/clock/index.js";
import { readDemoCsv, str, minorOrNull, toJsonb } from "./csv-helpers.js";

/**
 * Finding Q (audit): §25 places recon-source ingestion in Phase 4 (the actual
 * matching engine, §12), not Phase 0/1 — but the raw files themselves can be
 * *stored* now, since the tables they belong in (`recon_source_file`,
 * `recon_source_record`) already exist from Phase 0's §23 DDL. This is
 * ingestion only: every row is stored as-is (full row as `parsed` JSONB, plus
 * `amount_minor`/`value_date` promoted to first-class columns for basic
 * indexing) — no matching, no break detection, nothing that belongs to §12's
 * actual engine.
 *
 * `bulk_payment_input.csv` and `scroll-sample.txt` are NOT ingested here —
 * reported as a genuine gap (no Phase 0/1 schema table for bulk-batch or a
 * second scroll representation without inventing Phase 3/5 structures).
 */

export type ReconSource = "BANK_STATEMENT" | "SWITCH" | "RAIL" | "TREASURY_ACK";

interface ReconIngestSpec {
  filename: string;
  source: ReconSource;
  amountColumn: string;
  valueDateColumn: string;
}

// The recon batch these four files all belong to (demo-data/README.md and the
// scroll file's own name both state this business date explicitly — not
// invented).
const RECON_BUSINESS_DATE = "2026-07-30";

const SPECS: ReconIngestSpec[] = [
  { filename: "bank_statement_camt053.csv", source: "BANK_STATEMENT", amountColumn: "amount_minor", valueDateColumn: "value_date" },
  { filename: "switch_settlement_1link.csv", source: "SWITCH", amountColumn: "transaction_amount_minor", valueDateColumn: "txn_date" },
  { filename: "rail_settlement_raast.csv", source: "RAIL", amountColumn: "amount_minor", valueDateColumn: "business_date" },
  { filename: "scroll_fbr_20260730.csv", source: "TREASURY_ACK", amountColumn: "amount_minor", valueDateColumn: "value_date" },
];

/**
 * `recon_source_record.run_id` is `NOT NULL REFERENCES recon_run(id)` — a raw
 * ingestion still needs a `recon_run` row to hang off, even though no matching
 * pass runs against it yet. Its `status` stays the DDL default `'PENDING'`,
 * which is exactly what it is: sources ingested, matching not yet executed.
 * Idempotent — reuses the existing run for this business date/type if the
 * loader runs more than once.
 */
async function findOrCreateIngestionRun(trx: Transaction<Database>): Promise<string> {
  const existing = await trx
    .selectFrom("recon_run")
    .select("id")
    .where("business_date", "=", RECON_BUSINESS_DATE)
    .where("recon_type", "=", "THREE_WAY_DAILY_INGESTION")
    .executeTakeFirst();
  if (existing) return existing.id;

  const created = await trx
    .insertInto("recon_run")
    .values({
      recon_type: "THREE_WAY_DAILY_INGESTION",
      business_date: RECON_BUSINESS_DATE,
      status: "PENDING", // matching (§12) is Phase 4 — this run only holds ingested sources
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return created.id;
}

async function ingestOne(
  trx: Transaction<Database>,
  dir: string,
  spec: ReconIngestSpec,
  clock: Clock,
  runId: string,
): Promise<void> {
  const raw = readFileSync(join(dir, spec.filename));
  const fileHash = createHash("sha256").update(raw).digest();
  const rows = readDemoCsv(dir, spec.filename);

  const file = await trx
    .insertInto("recon_source_file")
    .values({
      source: spec.source,
      business_date: RECON_BUSINESS_DATE,
      filename: spec.filename,
      file_hash: fileHash,
      parsed_count: rows.length,
      parsed_total_minor: rows.reduce((sum, r) => sum + (minorOrNull(r[spec.amountColumn]) ?? 0n), 0n),
      status: "INGESTED",
      ingested_at: clock.now(),
    })
    .onConflict((oc) => oc.columns(["source", "file_hash"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();

  if (!file) return; // already ingested (same source + file hash) — §12.2's dedup, honoured even here

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, string>;
    await trx
      .insertInto("recon_source_record")
      .values({
        run_id: runId,
        source: spec.source,
        file_id: file.id,
        line_no: i + 1,
        raw_line: JSON.stringify(row),
        parsed: toJsonb(row) as never,
        amount_minor: minorOrNull(row[spec.amountColumn]),
        value_date: str(row[spec.valueDateColumn]),
        matched: false,
      })
      .execute();
  }
}

export async function ingestReconSourceFiles(trx: Transaction<Database>, demoDataDir: string, clock: Clock): Promise<void> {
  const runId = await findOrCreateIngestionRun(trx);
  for (const spec of SPECS) {
    await ingestOne(trx, demoDataDir, spec, clock, runId);
  }
}
