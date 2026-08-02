# 7. Glossary

Every domain term used in this manual and on the platform's own screens, defined in one place. Terms in *italics* within a definition are themselves defined elsewhere in this glossary.

---

**Agency**
A government body that issues bills and receives collections through the platform (e.g. the Federal Board of Revenue, the Punjab Safe Cities Authority). See the [agency portal](03-agency-portal.md).

**Agent float**
The running balance an *agent* (branchless-banking channel) owes the operator — collected cash minus remittances, always derived rather than cached. See [Agent / Branchless Banking](04-operator-portal.md).

**Amount in words**
The receipt's total spelled out in full, in English and Urdu, alongside the figure. Required on a receipt because words are far harder to alter after the fact than digits, and because it is the line somebody checks when a figure looks wrong.

**Allocation**
The record linking a specific *payment* (or part of one) to a specific *assessment* (or one of its line items). One payment can produce several allocations, spread across several assessments and even several agencies. See [Assessment, Payment, and Allocation](00-concepts.md#2-assessment-payment-and-allocation-are-three-separate-things).

**Assessment**
The platform's term for a bill — what an agency says a payer owes. Exists independently of whether it has been paid. Has an assessed amount, a due date, and one or more *line items*.

**Break resolution**
The two-person process of disposing of a *break*: an analyst proposes one of five resolutions (manual match, accept as timing, reclassify, write off, escalate to the agency) and a *different person in a different role* approves or rejects it. The only place in the platform where *maker-checker* requires distinct roles rather than merely distinct user accounts. See [the break register](04-operator-portal.md#break-register).

**Break**
A mismatch found during *reconciliation* between the platform's own ledger and an external source (bank statement, switch settlement file, rail settlement file). See [Screen 3 — Break Register](04-operator-portal.md).

**Chargeback / dispute**
A card scheme forcing the reversal of a *payment* weeks after it was completed, at the citizen's request through the card network rather than through the platform directly. Handled as its own lifecycle (RECEIVED → EVIDENCE_SUBMITTED → WON/LOST), distinct from an ordinary *refund*. See [Disputes & Chargebacks](04-operator-portal.md).

**Confirmed**
One of the three headline agency figures: money that has been definitively applied to an agency's bills. See [Confirmed, settled, and swept](00-concepts.md#3-confirmed-settled-and-swept-are-three-different-honestly-reported-numbers).

**Demo clock**
The fixed date-and-time value (30 July 2026, 12:00, Asia/Karachi) that every date-sensitive calculation in the demonstration environment uses instead of the real system clock, so the demonstration produces identical results every time it is run. Advanceable from the *demonstration harness*. See [The demo clock](01-demonstration-harness.md#the-demo-clock).

**Dishonour (of an instrument)**
When a bank returns a cheque, pay order, or demand draft unpaid (most commonly for insufficient funds). Triggers the [dishonour cascade](04-operator-portal.md).

**Demonstration harness**
The dark bar above every portal carrying the persona switcher, the portal switcher, the *demo clock*, **Reset**, and **Break the chain**. Not part of the product — labelled as such — because none of those controls belong to a real user, least of all one that deliberately corrupts the ledger. See [The demonstration harness](01-demonstration-harness.md).

**Hash chain**
A cryptographic technique where each record links to the one before it, such that altering any past record breaks the chain at exactly that point, making tampering both detectable and locatable. The platform maintains **two independent** hash chains: one for the financial ledger, one for the audit trail of user/system actions. See [Control Assertions](04-operator-portal.md) and [Audit Explorer](04-operator-portal.md).

**Instrument lodgement**
Accepting a physical instrument (cheque, post-dated cheque, pay order, demand draft) at a counter: creating the instrument, linking it to the bills it is tendered against, and capturing a *provisional* payment. Refuses a part-allocated instrument and a duplicate instrument number. See [the field portal](05-field-portal.md#lodge-a-cheque).

**Ledger**
The platform's permanent, append-only record of every financial entry. Nothing is ever edited or deleted from it — corrections are made by posting new, offsetting entries, never by altering history.

**Line item**
A specific component of an assessment's total amount — for example, a single bill might be broken into a "principal" line item, a "surcharge" line item, and a "penalty" line item, each tracked and allocated against separately.

**Maker-checker**
A control requiring two different people: one to propose or perform an action (the "maker"), and a different one to review and approve it (the "checker"). Enforced by the system itself for actions like break resolution and refund approval — the same user account cannot do both. See [the introduction](00-concepts.md#6-maker-checker-separation-of-duties).

**Mandate**
A payer's standing, pre-granted authorisation for the platform to collect recurring bills against a specific product, up to a maximum amount per collection, without asking each time. Implemented as an automated *Request to Pay* whose acceptance was already granted when the mandate was created. See [Mandates](04-operator-portal.md).

**Payable amount**
What must actually be collected for a bill today — the *assessed* amount less any live discount. Distinct from the assessed amount, which the bill's *line items* always sum to. A payment is allocated against the payable, never the assessed, so a discounted bill settles at the figure the payer was quoted.

**Persona**
One of the platform's real users, chosen from the *demonstration harness* so that every request carries that user's genuine identity and roles. Each portal offers only the people who belong in it; the citizen portal offers none, because it is public.

**Portal**
One of the platform's four separately-served applications — citizen, agency, operator, field — each on its own address, each for one kind of person. See [Four portals, not one screen](00-concepts.md).

**Provisional funds**
Money that is confirmed but not final, because the instrument behind it has not cleared. Can never be *swept* to treasury, and the *receipt* for it must say so on its face. See [the field portal](05-field-portal.md#lodge-a-cheque).

**PSID (Payment Slip ID)**
The canonical, unique identifier for a bill (*assessment*) in the platform — a long numeric reference with a built-in check digit that catches typos and transposition errors before any lookup is even attempted. **Minted** by the platform when an agency issues a bill without supplying one, using the product's own reference scheme so the result is immediately resolvable and its check digit genuine.

**Rail**
The underlying payment network or mechanism that actually moves money (e.g. RAAST, 1LINK, a card network). Distinct from *channel* (the citizen-facing way they interact — a bank's mobile app, a wallet, a physical counter) — several channels can route through the same rail.

**Recall**
A request to return a payment made very soon after it happened, resolved differently depending on whether the money has been allocated to a bill, swept to the agency, or neither. Distinct from a *refund*, which can be raised at any time, for any reason. See [Recall a Payment](04-operator-portal.md).

**Reconciliation**
The process of comparing the platform's own ledger against independent external sources (the bank's statement, the switch's settlement file, the rail's settlement file) to confirm they agree, and surfacing any mismatch as a *break*. Run daily. See [the break register](04-operator-portal.md).

**Refund**
Money returned to a payer, under full maker-checker approval, always defaulting to the account the original payment came from unless an approved override changes it. See [Refunds](04-operator-portal.md).

**Refundable deposit**
A payment (e.g. a tender security or litigation deposit) that is not agency revenue at all — credited to a dedicated liability account rather than the ordinary revenue account, and ultimately refunded, forfeited, or converted to revenue as a distinct decision. See [Refundable Deposits](04-operator-portal.md).

**Reference type**
The kind of identifier used to look up a bill on [the citizen portal](02-citizen-portal.md) — PSID, vehicle registration, CNIC, case number, QR payload, and several others. All reference types for the same payer or property resolve to the same underlying *assessment(s)*.

**Request to Pay (RtP)**
A message sent to a specific payer asking them to settle a specific bill by a given expiry date — the platform proactively asking to be paid, rather than only waiting for the payer to look up a bill on their own. See [Request to Pay](04-operator-portal.md).

**Revenue head**
The specific budget/legal category a portion of collected money belongs to (e.g. "B01101 — Income Tax on Companies," "B02391 — Penalty - Income Tax"). Government financial reporting is organized around revenue heads, which is why the [agency portal](03-agency-portal.md) breaks every figure down this way rather than reporting one lump sum.

**Role**
One of twelve named internal permissions a platform user holds (e.g. `AGENCY_ADMIN`, `OPS_RECON_ANALYST`), enforced server-side against specific actions — never merely by hiding a button. See [Roles](04-operator-portal.md#roles).

**Scroll**
A formal, itemised hand-off document — one line per allocation — generated when money is *swept* to treasury, used by treasury to acknowledge receipt of exactly what the platform says it sent. Never emitted unless its total ties exactly to the ledger. See [Settlement & Sweep](04-operator-portal.md).

**Settled**
One of the three headline agency figures: an assessment (bill) has reached a fully-paid state. See [Confirmed, settled, and swept](00-concepts.md#3-confirmed-settled-and-swept-are-three-different-honestly-reported-numbers).

**Swept**
One of the three headline agency figures: money has been physically transferred out of the platform's collection account into government treasury. The most conservative of the three figures — provisional (uncleared) money can never be counted as swept. See [Confirmed, settled, and swept](00-concepts.md#3-confirmed-settled-and-swept-are-three-different-honestly-reported-numbers).

**Unapplied (money / receipt)**
Money the platform has genuinely received but has not yet linked to a specific bill — held safely, fully accounted for, and tracked in its own queue, rather than ever being rejected. See [Unapplied Receipts Queue](04-operator-portal.md).

**`UNCERTAIN`**
A dedicated, temporary payment state used whenever the platform cannot yet determine whether a payment succeeded. Never shown to the payer as a failure. Always eventually resolves to either `CONFIRMED` or `FAILED`, based on real evidence. See [the introduction](00-concepts.md#4-uncertain-is-a-real-first-class-state--not-a-failure) and the [UNCERTAIN Payments Queue](04-operator-portal.md).

**`value_date` vs. `created_at`**
Two intentionally separate dates the platform tracks for every financial entry: `value_date` is the *business* date an entry counts against (in Asia/Karachi local time — the date that matters for due dates, surcharge calculations, and reporting periods); `created_at` is the exact system timestamp the entry was technically recorded (in UTC — the date/time that matters for technical audit purposes). These are never conflated, because a transaction processed just after midnight system time might still need to count against the *previous* business day.

**Till close**
End of a teller's shift: the drawer is counted, and any difference from what the platform expected is posted to the ledger as a real over/short journal entry rather than absorbed. Idempotent — closing twice posts once. See [the field portal](05-field-portal.md#close-the-till).

**Waterfall**
The configured order in which a payment is applied across an assessment's multiple *line items* when it doesn't fully cover everything owed (for example, penalty-first, principal-first, or oldest-bill-first). Configured per agency and product, and visible on the agency portal's [Products](03-agency-portal.md#products) screen.

---

*Return to the [Manual index](README.md).*
