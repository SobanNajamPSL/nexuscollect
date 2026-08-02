# What the demonstration does not show

Stated plainly, because a demonstration that implies more than the build does is
worse than one that admits its edges. Nothing below is hidden in the film by
careful framing; it simply is not there.

## Deliberately out of scope for this build

These were excluded by decision, not by omission, and the reasoning is recorded in
`CLAUDE.md` and the specification's own §19–§20.

| Not built | Why |
|---|---|
| **Real authentication** | Portals first, identity later. The demonstration harness stands in for it, and is visibly labelled as a harness rather than dressed up as a login. |
| **HSM key rotation** | The specification treats §19 as design commentary for this build. Receipt signing is real and verifiable; the key is a fixed demonstration key held in configuration. |
| **DR failover automation** | Same. |
| **Load testing to 3,000 TPS** | Same. Latency budgets are measured for resolve and apply; throughput at scale is not claimed. |
| **A live card gateway** | Card capture is genuinely hosted-field-only — no PAN field exists anywhere — but there is no acquirer on the other end. What is stored (token, BIN6, last4) is what would be stored in production. |
| **Live SMS or push delivery** | The notification module, its quiet hours and its per-payer caps are real; there is no provider connected to send through. |
| **The `/v1/agency/*` institution contract, end to end** | The published OpenAPI contract is wider than the implemented surface. This is a documented gap between contract and build, not a claim that it works. |

## Deferred, and worth naming

**Fraud and risk signals.** Enumeration ratios, velocity checks and
overpay-refund patterns are not implemented. `risk_rating` exists on the payer
record as a loaded field and is honestly unused. It would be easy to put a number
on a screen here and much harder to justify it.

**Digital-versus-cash mix by payer cohort.** The single best proxy for whether a
digitisation programme is working, and the platform does not tag cohorts — so the
operator portal reports it as *not tracked* rather than approximating it. An
estimate presented as a measurement is worse than a stated gap.

## Narrowings inside things that *are* built

These are real capabilities with a disclosed edge, each stated in the code that
implements it rather than only here.

**Instrument credit policies.** The three policies differ on service gating *and* on
whether allocation waits for clearing. Service gating is modelled; allocation happens
at lodgement regardless of policy. Provisional funds are still never sweepable, which
is the guarantee that matters.

**Minted PSIDs.** The reference layout is the product's own documented scheme, and the
check digit is genuine. Two narrowings: the sequence is a pure counter rather than
partly random, so the demonstration stays deterministic; and the product code is read
from the product's existing bills rather than a separate registry.

**`UNCERTAIN` resolution.** The state machine and all five escalation strategies are
real. The integrations they would call — a rail status enquiry, a statement ingestion
— are stubbed, because there is no rail to call in a demonstration. The stubs are
stubs in the code, not simulated successes.

**Request to Pay delivery.** The lifecycle, the state machine, the audit trail and
automatic fulfilment on payment are all real. What is *not* real is the delivery
channel: no notification is sent to the payer's phone, so the payer's own steps
(opening the request, accepting it) are driven from the agency screen in the
demonstration. The film says so plainly rather than implying a message went out.

**Print-and-pay challan.** Rendered as HTML rather than PDF.

**Break severities and thresholds.** Where the specification marks a figure as
unverified, it is configuration here rather than a hardcoded constant presented as
fact.

## Things the film compresses

Not gaps, but worth knowing if somebody asks "did that really just happen":

- **The clock.** Three days do not pass between the cheque being lodged and the bank
  returning it. The demonstration clock is pinned, and the return is triggered
  directly — which is what a bank's return file would do anyway.
- **Some setup happens through the API rather than on camera.** Where a beat needs
  state an earlier beat produced — so that a standalone clip makes sense on its own —
  that state is created through the same endpoints the portals call. It is never
  written into the database directly.
- **Reconciliation is run on camera**, against the three real source files already
  ingested. The eleven breaks are not planted at the moment of the demonstration;
  they are in the seeded dataset and the fixture asserts exactly which eleven.
