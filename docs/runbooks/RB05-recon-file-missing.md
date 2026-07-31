# RB05 — Recon file missing or malformed

**Trigger:** an expected source file (bank statement, switch settlement, rail
settlement, treasury ack) has not arrived by its SLA, or fails control-total
validation on ingest.

## Steps

1. **Chase the partner** for the missing/corrected file before doing anything else.
2. **Do NOT reconcile a partial file.** The recon engine's own ingestion layer
   (`src/loader/ingest-recon-source.ts`) is designed around whole-file control
   totals; a file whose declared control total disagrees with what was parsed
   fails the ingest — this is not a bug to route around, it's the control working.
3. **Hold the run.** `runReconciliation` (`modules/recon/index.ts`) is idempotent
   and safe to defer — do not force a run against an incomplete source set just
   to hit a reporting deadline.
4. **Notify the agency of delayed certification.** R03 (Daily Reconciliation
   Certificate) cannot be signed off for a business date whose recon run is
   incomplete — say so explicitly rather than shipping a certificate with a
   silently-optimistic match rate.
