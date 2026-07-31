# RB08 — Cheque return batch

**Trigger:** a bank returns-file arrives with one or more dishonoured cheques.

## Steps

1. **Process the cascade per instrument.** `returnInstrument` (`modules/instrument/index.ts`)
   is the full §14.6 cascade: reverses every allocation the cheque funded, un-settles
   the affected assessments, resumes surcharge accrual from the ORIGINAL due date
   (not from today), voids the receipts, re-closes any released `service_gate_token`,
   and raises a new dishonour-charge assessment.
2. **Verify balances restored.** After processing, confirm each affected
   assessment's `balance_minor` matches what it was before the cheque was lodged
   (`checkBalanceRebuild` / `rebuildAssessmentBalance` give an independent
   recomputation, not just a re-read of the cached column).
3. **Notify.** `modules/notification` with `event_type='instrument.returned'` —
   §16.3 requires the return reason, restored balance, dishonour charge, and how
   to remedy, all in one message.
4. **Re-presentment.** If the return reason is re-presentable
   (`INSUFFICIENT_FUNDS` — yes; `SIGNATURE_DIFFERS`/`ACCOUNT_CLOSED` — no), a
   single re-presentment is permitted per §9.5; do not re-present a
   non-re-presentable reason no matter how the batch arrived.
