# RB03 — Agency system outage (quote/notify API failing)

**Trigger:** an agency's on-demand quote endpoint (§8.12's on-demand-assessment
pattern) stops responding.

## Steps

1. **Circuit breaker on.** Stop calling the agency's quote endpoint for new
   resolutions of that agency's products; fail fast rather than let its latency
   become the platform's latency (§8.12's own warning).
2. **Serve cached payables where safe.** Only for products whose amount doesn't
   change between quote and payment (no live surcharge/discount) — for anything
   using `compute_derived` (surcharge/discount), a stale cached amount is worse
   than an honest unavailability response, since §15.4 requires the payer never
   be shown a stale amount.
3. **Queue notifications** rather than dropping them — `modules/notification`'s
   `notification_log` already records `SENT`/`SUPPRESSED_*` outcomes; a queued
   notification should be retried once the agency system recovers, not silently lost.
4. **Do not guess amounts.** If the agency's own system is the source of truth for
   an on-demand liability and it's down, the correct resolve outcome is
   `AGENCY_UNAVAILABLE` (§8.2 step 6's eligibility check already returns this),
   never an estimated figure.
