# RB04 — `UNCERTAIN` spike

**Trigger:** queue-depth alert on `payment` rows with `status='UNCERTAIN'`
(§9.4: >30 min old is P2, >4h is P1).

## Steps

1. **Query the queue.**
   `SELECT * FROM payment WHERE status='UNCERTAIN' ORDER BY received_at ASC`
   — age and rail/channel distribution identifies the failing integration
   immediately (this is exactly why `uncertain_resolution_source` exists once
   resolved: "it tells you which upstream integration is unreliable").
2. **Run the resolver.** `resolveUncertainPayment` (`modules/payment/index.ts`)
   takes an outcome (`FOUND_PAID`/`FOUND_NOT_PAID`/`STILL_UNRESOLVED`) and a
   `source` (`RAIL_STATUS_ENQUIRY`/`AGGREGATOR_ADVICE`/`INTRADAY_STATEMENT`/
   `EOD_STATEMENT`/`HUMAN_INVESTIGATION`) — escalate through these five
   strategies in order per §9.4.
3. **Escalate to the partner** if the same rail/channel accounts for a
   disproportionate share of the queue.
4. **Consider disabling that channel** (remove it from the affected products'
   `allowed_channels`) if the partner cannot confirm a fix quickly — better to
   turn off a channel than let payers keep landing in `UNCERTAIN`.

**Never** show an `UNCERTAIN` payment to its payer as failed (§9.4 rule 2) —
this is enforced at the UI layer (Screen 1's "we're confirming your payment"
state), not just documented here.
