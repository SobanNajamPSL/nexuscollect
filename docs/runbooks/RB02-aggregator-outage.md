# RB02 — Aggregator outage (switch down)

**Trigger:** the 1LINK/switch stops responding to Bill Inquiry/Bill Payment calls.

## Steps

1. **Confirm.** `POST /switch/v1/bill-inquiry` calls timing out or returning non-200
   from the switch's own client is the primary signal — this endpoint (`src/adapters/switch/index.ts`)
   is a pure read and should never be slow under normal conditions.
2. **Expect reversals.** A switch outage frequently produces late
   `POST /switch/v1/bill-payment-reversal` calls for payments the switch believes
   timed out on its side even though our `billPayment` actually committed. This is
   exactly §8.6's "reversal without an original" case (`SwitchReversalRequest` with
   no matching payment yet) — the adapter stores it `PENDING_ORIGINAL` in
   `switch_pending_reversal` and auto-pairs when/if a late Bill Payment for the same
   `(acquirer_id, stan, rrn, txn_date)` arrives (`tryPairPendingReversal`).
3. **Hold `PENDING_REVERSAL` items** — do not manually resolve
   `switch_pending_reversal` rows while the outage is ongoing; let the auto-pairing
   logic run once the switch recovers and late messages arrive.
4. **Reconcile against the switch's settlement file on recovery.** `runReconciliation`
   ingests `switch_settlement_1link.csv`-shaped data via the recon source loader;
   B04 (duplicate STAN/RRN) and B07 (fee variance) are the breaks most likely to
   surface after a switch outage and partial replay.
