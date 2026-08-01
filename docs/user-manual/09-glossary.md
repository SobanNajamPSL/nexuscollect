# 9. Glossary

Every domain term used in this manual and on the platform's own screens, defined in one place. Terms in *italics* within a definition are themselves defined elsewhere in this glossary.

---

**Agency**
A government body that issues bills and receives collections through the platform (e.g. the Federal Board of Revenue, the Punjab Safe Cities Authority). See the [Agency Dashboard](05-agency-dashboard.md).

**Allocation**
The record linking a specific *payment* (or part of one) to a specific *assessment* (or one of its line items). One payment can produce several allocations, spread across several assessments and even several agencies. See [Assessment, Payment, and Allocation](00-introduction-and-concepts.md#2-assessment-payment-and-allocation-are-three-separate-things).

**Assessment**
The platform's term for a bill — what an agency says a payer owes. Exists independently of whether it has been paid. Has an assessed amount, a due date, and one or more *line items*.

**Break**
A mismatch found during *reconciliation* between the platform's own ledger and an external source (bank statement, switch settlement file, rail settlement file). See [Screen 3 — Break Register](03-break-register.md).

**Confirmed**
One of the three headline agency figures: money that has been definitively applied to an agency's bills. See [Confirmed, settled, and swept](00-introduction-and-concepts.md#3-confirmed-settled-and-swept-are-three-different-honestly-reported-numbers).

**Demo clock**
The fixed date-and-time value (30 July 2026, Asia/Karachi) that every date-sensitive calculation in the demonstration environment uses instead of the real system clock, so the demo produces identical results every time it's run. See [The demo clock](00-introduction-and-concepts.md#the-demo-clock).

**Dishonour (of an instrument)**
When a bank returns a cheque, pay order, or demand draft unpaid (most commonly for insufficient funds). Triggers the [dishonour cascade](04-instrument-register.md#step-2--return-dishonour-an-instrument).

**Hash chain**
A cryptographic technique where each record links to the one before it, such that altering any past record breaks the chain at exactly that point, making tampering both detectable and locatable. The platform maintains **two independent** hash chains: one for the financial ledger, one for the audit trail of user/system actions. See [Control Assertions](06-control-assertions.md) and [Audit Explorer](07-back-office-screens.md#audit-explorer).

**Ledger**
The platform's permanent, append-only record of every financial entry. Nothing is ever edited or deleted from it — corrections are made by posting new, offsetting entries, never by altering history.

**Line item**
A specific component of an assessment's total amount — for example, a single bill might be broken into a "principal" line item, a "surcharge" line item, and a "penalty" line item, each tracked and allocated against separately.

**Maker-checker**
A control requiring two different people: one to propose or perform an action (the "maker"), and a different one to review and approve it (the "checker"). Enforced by the system itself for actions like break resolution and refund approval — the same user account cannot do both. See [the introduction](00-introduction-and-concepts.md#6-maker-checker-separation-of-duties).

**PSID (Payment Slip ID)**
The canonical, unique identifier for a bill (*assessment*) in the platform — a long numeric reference with a built-in check digit that catches typos and transposition errors before any lookup is even attempted.

**Rail**
The underlying payment network or mechanism that actually moves money (e.g. RAAST, 1LINK, a card network). Distinct from *channel* (the citizen-facing way they interact — a bank's mobile app, a wallet, a physical counter) — several channels can route through the same rail.

**Reconciliation**
The process of comparing the platform's own ledger against independent external sources (the bank's statement, the switch's settlement file, the rail's settlement file) to confirm they agree, and surfacing any mismatch as a *break*. Run daily. See [Screen 3](03-break-register.md).

**Reference type**
The kind of identifier used to look up a bill on [Screen 1](01-citizen-payment.md) — PSID, vehicle registration, CNIC, case number, QR payload, and several others. All reference types for the same payer or property resolve to the same underlying *assessment(s)*.

**Revenue head**
The specific budget/legal category a portion of collected money belongs to (e.g. "B01101 — Income Tax on Companies," "B02391 — Penalty - Income Tax"). Government financial reporting is organized around revenue heads, which is why the [Agency Dashboard](05-agency-dashboard.md) breaks every figure down this way rather than reporting one lump sum.

**Scroll**
A formal, itemised hand-off document — one line per allocation — generated when money is *swept* to treasury, used by treasury to acknowledge receipt of exactly what the platform says it sent. Never emitted unless its total ties exactly to the ledger. See [Settlement & Sweep](07-back-office-screens.md#settlement--sweep).

**Settled**
One of the three headline agency figures: an assessment (bill) has reached a fully-paid state. See [Confirmed, settled, and swept](00-introduction-and-concepts.md#3-confirmed-settled-and-swept-are-three-different-honestly-reported-numbers).

**Swept**
One of the three headline agency figures: money has been physically transferred out of the platform's collection account into government treasury. The most conservative of the three figures — provisional (uncleared) money can never be counted as swept. See [Confirmed, settled, and swept](00-introduction-and-concepts.md#3-confirmed-settled-and-swept-are-three-different-honestly-reported-numbers).

**Unapplied (money / receipt)**
Money the platform has genuinely received but has not yet linked to a specific bill — held safely, fully accounted for, and tracked in its own queue, rather than ever being rejected. See [Unapplied Receipts Queue](07-back-office-screens.md#unapplied-receipts-queue).

**`UNCERTAIN`**
A dedicated, temporary payment state used whenever the platform cannot yet determine whether a payment succeeded. Never shown to the payer as a failure. Always eventually resolves to either `CONFIRMED` or `FAILED`, based on real evidence. See [the introduction](00-introduction-and-concepts.md#4-uncertain-is-a-real-first-class-state--not-a-failure) and the [UNCERTAIN Payments Queue](07-back-office-screens.md#uncertain-payments-queue).

**`value_date` vs. `created_at`**
Two intentionally separate dates the platform tracks for every financial entry: `value_date` is the *business* date an entry counts against (in Asia/Karachi local time — the date that matters for due dates, surcharge calculations, and reporting periods); `created_at` is the exact system timestamp the entry was technically recorded (in UTC — the date/time that matters for technical audit purposes). These are never conflated, because a transaction processed just after midnight system time might still need to count against the *previous* business day.

**Waterfall**
The configured order in which a payment is applied across an assessment's multiple *line items* when it doesn't fully cover everything owed (for example, penalty-first, principal-first, or oldest-bill-first). Configured per agency/product on the [Agency Config](07-back-office-screens.md#agency-config) screen.

---

*Return to the [Manual index](README.md).*
