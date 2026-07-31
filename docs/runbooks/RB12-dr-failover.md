# RB12 — DR failover

**Trigger:** primary site loss.

## Explicitly not built in this demo

CLAUDE.md is direct about this: *"Start on HSM key rotation, DR rehearsals or
3,000 TPS load tests — No. §19 and §20 are design commentary for this build,
not backlog."* No automated failover, no documented/timed DR rehearsal, and no
secondary-site replication exists in this codebase. This runbook is therefore a
disclosed placeholder plus the one thing this build genuinely gives a real DR
process to lean on:

## What a real failover MUST verify before resuming writes (this build supports this check today)

1. **Ledger integrity.** `GET /internal/ledger/verify-chain`
   (`verifyLedgerChain`, `modules/ledger/index.ts`) walks the entire
   `journal_entry` chain from genesis and names the first entry whose stored
   hash no longer matches its recomputed content. Run this against the
   recovered database BEFORE accepting any new write — a DR recovery that
   skips this check is exactly how a corrupted or partially-restored ledger
   gets built on top of.
2. **The five §10.8 controls**, in full
   (`trial-balance`, `allocation-integrity`, `balance-rebuild`,
   `ledger-vs-subledger`) — same reasoning as RB06.
3. **Time and log the failover itself** — §19's own instruction ("execute and
   TIME the documented failover") — even though the failover mechanics
   themselves are out of this build's scope, the verification steps above are
   real and must be run and timed regardless of which infrastructure DR
   approach a real deployment chooses.

Building the actual failover automation, secondary-site replication, and a
rehearsed/timed DR drill schedule is real, substantial work explicitly deferred
per CLAUDE.md — recorded here as an honest gap, not quietly assumed done.
