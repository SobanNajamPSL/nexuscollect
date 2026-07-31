# RB11 — Scroll rejected

**Trigger:** the treasury's acknowledgement of a transmitted scroll comes back
`REJECTED` (`recordScrollAck(db, scrollId, "REJECTED", clock)`,
`modules/settlement`).

## Steps

1. **Identify the head errors.** The real fixture pattern for this
   (`demo-data/scroll_fbr_20260730.csv`'s line 13, `ack_reason=HEAD_NOT_VALID_FOR_PERIOD`)
   is exactly what this runbook is for — one or more detail lines were classified
   to a revenue head the treasury doesn't accept for that tax period.
2. **Reclassify.** Fix the head mapping (`revenue_head`/product `mapping_rule`,
   §15.3) for future scrolls — a rejection is a classification signal, not a
   cash-missing one (matches recon's own B09 classification, "money's already
   banked, just misfiled").
3. **Issue a supplementary scroll.** `generateScroll` called again for the same
   agency/business-date produces a NEW `scroll` row with an incremented
   `sequence_no` — this IS the supplementary scroll mechanism; it is a fresh,
   independently-generated document, never a mutation of the original.
4. **Never edit and resend the original.** `scroll`/`scroll_line` rows are never
   updated once generated in this codebase — there is no UPDATE path for them at
   all, matching §13.5 rule 2 ("Scrolls are immutable once transmitted") by
   construction, not by convention.
5. A `REJECTED` ack also raises a real `B09` break in `recon_break`
   (`recordScrollAck`'s own side effect) — it will show up on the Break
   Register the same way the fixture's own planted B09 does.
