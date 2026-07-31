# RB07 — Duplicate-payment storm

**Trigger:** duplicate-rate alert — a spike in `payment.duplicate_of_payment_id`
being set (the "probable duplicate" tier, §14.5) or in `HardDuplicatePaymentError`
throws (the hard tier) for one channel/rail.

## Steps

1. **Identify the source channel.**
   `SELECT channel, rail, count(*) FROM payment WHERE duplicate_of_payment_id IS NOT NULL AND received_at > now() - interval '1 hour' GROUP BY channel, rail`
   — a storm is almost always one channel/integration double-submitting.
2. **Rate-limit it.** Channel-level throttling, not a platform-wide slowdown.
3. **Batch-refund.** Every probable duplicate already has a real `refund` row in
   `PENDING_APPROVAL` (`modules/refund.createRefund`, called automatically from
   `capturePayment`'s duplicate-detection step) — this runbook is "approve and pay
   the batch" (`approveRefund` + `payRefund`), not "investigate whether refunds
   are owed." They already are.
4. **Notify affected payers** via `modules/notification` (`refund.initiated`
   event type) — §14.5's own rule is "always accept the money and refund it,"
   so payers should hear "you'll be refunded," never "your payment was rejected."
