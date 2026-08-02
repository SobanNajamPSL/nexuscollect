# NexusCollect — user manual

A guide to what the platform does and how each of its four portals is used, written
for somebody who has not seen it before. No technical background is assumed; where a
design decision needs justifying, the justification is given rather than asserted.

Every figure, reference, PSID and receipt number in this manual comes from the
platform running against its seeded demonstration data at the fixed business date
**30 July 2026**. None of them are illustrative. Every screenshot is captured by
`scripts/capture-screens.ts`, which walks all four portals and fails if any screen
produces a console error, a failed request, or missing data — so the images and the
build cannot drift apart silently.

## Read in this order

| | Document | What it covers |
|---|---|---|
| 0 | [Introduction & core concepts](00-concepts.md) | What the platform is, who uses it, the ideas everything else depends on, and the four-portal model. |
| 1 | [The demonstration harness](01-demonstration-harness.md) | The controls above every portal: becoming a different person, moving the clock, resetting, and deliberately breaking the ledger. **Read before the portal chapters.** |
| 2 | [The citizen portal](02-citizen-portal.md) | Public, phone-shaped: find a bill by any reference, pay it, and the receipt — including Urdu and offline verification. |
| 3 | [The agency portal](03-agency-portal.md) | One agency's own position, head-wise, with confirmed, settled and swept as three separate numbers; issuing bills; treasury and scrolls. |
| 4 | [The operator portal](04-operator-portal.md) | The back office: nineteen screens across investigation, reconciliation, exceptions, money movement and assurance. |
| 5 | [The field portal](05-field-portal.md) | Counters and shops: cash, cheque lodgement, till close, agent float. |
| 6 | [Flows & diagrams](06-flows-and-diagrams.md) | The major end-to-end processes as diagrams, showing how the portals connect. |
| 7 | [Glossary](07-glossary.md) | Every domain term used anywhere in the manual or on screen. |

## If you only have ten minutes

Read the four ideas in [§0](00-concepts.md) — assessment/payment/allocation as three
separate things, confirmed/settled/swept as three separate numbers, `UNCERTAIN` as a
first-class state, and maker-checker — then look at two screens:

1. The [agency portal's collection position](03-agency-portal.md#collection-position),
   for what the platform is *for*.
2. The [operator portal's control assertions](04-operator-portal.md#control-assertions),
   for why the figures on it can be believed.

## The two moments worth watching

- **The dishonour cascade.** One returned cheque, six downstream effects, each landing
  visibly — including a receipt that verified as valid a minute ago and now verifies as
  voided. See [Instrument clearing](04-operator-portal.md#instrument-clearing).
- **Breaking the chain.** Corrupt a ledger row from the harness, re-run the control
  assertions, and watch the platform name the specific entry you altered. See
  [Control assertions](04-operator-portal.md#control-assertions).

## Related documents

- [`docs/demo/`](../demo/) — the recording script, shot list and the recordings themselves
- [`docs/runbooks/`](../runbooks/) — twelve operational runbooks for the failure modes the platform is expected to survive
- [`docs/UI-BRIEF.md`](../UI-BRIEF.md) — the original design brief, kept for provenance
- [`docs/ui-prototype/`](../ui-prototype/) — the validated reference prototype the first six screens were built against
- `P2G-Collection-Platform-Design.md` — the normative specification, in the repository root
