# RB01 — Rail outage (Raast unavailable)

**Trigger:** Raast reports unavailable or a spike in `UNCERTAIN`/`FAILED` payments on `rail=RAAST`.

## Steps

1. **Confirm scope.** Check `GET /internal/control/allocation-integrity` and query
   `payment` for `rail='RAAST' AND status IN ('UNCERTAIN','FAILED') AND received_at > now() - interval '15 minutes'`
   to size the blast radius before doing anything else.
2. **Switch eligible products to the alternate rail.** Product-level `allowed_channels`
   / rail eligibility is config (`collection_product`), not code — no platform deploy
   is needed to redirect traffic to `IBFT_1LINK`/`PRISM_RTGS` for products that support them.
3. **Notify channels and agencies.** Use `POST /internal/notifications/send` with
   `event_type` appropriate to the affected assessments; this respects quiet hours
   and the per-payer cap automatically (`modules/notification`).
4. **Suspend RtP dispatch** for RAAST-delivered RtPs: do not call `markSent`
   (`modules/rtp`) for new RtPs against RAAST-only products until recovery.
5. **Reconcile on recovery.** Run `runReconciliation` (`POST /internal/recon/run`)
   for the affected business date once Raast confirms recovery — this is exactly
   what the B01/B02/B05 breaks in the recon engine are built to catch (unmatched
   credits, unmatched platform payments, timing differences).

**Do not guess** whether an in-flight RAAST payment succeeded — anything not
definitively confirmed stays `UNCERTAIN` (§9.4) until the resolver or a rail
status enquiry confirms it (`resolveUncertainPayment`, `modules/payment`).
