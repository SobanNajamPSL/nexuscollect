# RB06 — Control assertion failure (§10.8)

**Trigger:** any of the five live checks on the operator portal's Control assertions screen
(`GET /internal/control/trial-balance`, `/allocation-integrity`,
`/balance-rebuild`, `/ledger-vs-subledger`, `/internal/ledger/verify-chain`)
goes red.

## Steps

1. **Freeze sweeps immediately.** Do not call `runSweep` (`modules/settlement`)
   for any agency until the specific failing control is understood — sweeping
   money out while the ledger is provably inconsistent turns a data problem into
   a cash problem.
2. **Identify the entries.** `verify-chain` names the exact tampered/broken
   `journal_entry` (`verifyLedgerChain`, `modules/ledger/index.ts`); the other
   four checks return structured `breaks[]`/differences, not just a boolean —
   use those to find the exact payment/assessment/agency involved.
3. **Engage engineering.** This is not an ops-resolvable class of incident.
4. **Do not post a plug entry to make it balance.** `journal_entry`/`journal_line`
   are append-only (§0.2 rule 2, enforced by a DB `RULE ... DO INSTEAD NOTHING`)
   specifically so this temptation is structurally unavailable, not just
   discouraged.
5. **Period close is already blocked** while this control is red — `closePeriod`
   (`modules/settlement`) runs the same five checks via `runPreCloseChecks` and
   throws `PeriodCloseBlockedError` rather than letting a period close over an
   inconsistent ledger.
