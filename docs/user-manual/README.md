# NexusCollect User Manual

**A complete, business-user reference guide to the NexusCollect Person-to-Government (P2G) Collection Platform.**

This manual documents every screen, workflow, and concept in the platform as it exists today, written for the people who will actually use it — agency finance officers, reconciliation analysts, tellers, approvers, and citizens paying a bill — not for developers. Every figure, reference number, and screenshot in this manual comes from the platform's own seeded demonstration dataset; nothing here is invented or approximated.

---

## How this manual is organized

| # | Document | What it covers |
|---|---|---|
| 0 | [Introduction & Core Concepts](00-introduction-and-concepts.md) | What the platform is, who it's for, and the handful of ideas you need before anything else makes sense (PSID, the Assessment/Payment/Allocation split, confirmed vs. settled vs. swept, the `UNCERTAIN` state, the demo clock) |
| 1 | [Screen 1 — Citizen Payment](01-citizen-payment.md) | How a citizen (or a teller on their behalf) finds and pays a bill |
| 2 | [Screen 2 — Receipt & Verification](02-receipt-and-verification.md) | Reading a receipt, and proving one is genuine without a login |
| 3 | [Screen 3 — Break Register](03-break-register.md) | Daily bank/switch/rail reconciliation and how mismatches ("breaks") are found, classified, and cleared |
| 4 | [Screen 4 — Instrument Register](04-instrument-register.md) | Managing cheques, pay orders, and demand drafts — including what happens when a cheque bounces |
| 5 | [Screen 5 — Agency Dashboard](05-agency-dashboard.md) | The head-wise financial position of a government agency: confirmed, settled, and swept, kept honestly separate |
| 6 | [Screen 6 — Control Assertions](06-control-assertions.md) | The five live checks that prove the books are correct, and how tampering is detected |
| 7 | [Back-Office Screens](07-back-office-screens.md) | The 12 operational screens used by internal staff day to day (search, queues, till, settlement, approvals, config, reports, audit) |
| 8 | [Flows & Diagrams](08-flows-and-diagrams.md) | Visual, end-to-end diagrams of the major processes — the payment lifecycle, the cheque dishonour cascade, the settlement/sweep cycle, and more |
| 9 | [Glossary](09-glossary.md) | Every domain term used in this manual and in the platform's own screens, defined in one place |
| 10 | [Payment Channels & Money-Movement Flows](10-payment-channels-and-flows.md) | Request to Pay, refunds, recalling a payment, bulk corporate files, standing mandates, card & wallet payments, offline-verifiable signed receipts, and the agent/branchless-banking channel |
| 11 | [Exceptions, Configuration & Governance](11-exceptions-configuration-and-governance.md) | Disputes & chargebacks, refundable deposits and third-party payer, the agency/product configuration wizard, roles & permissions, and the Ops/Executive dashboards |

## Who should read what

- **A citizen or front-line support agent** paying a bill: read documents 1 and 2 only.
- **A reconciliation analyst or approver**: read documents 0, 3, and 7 (Recon Console, Approvals Inbox sections).
- **An agency finance officer**: read documents 0, 5, 7 (Report Centre, Settlement & Sweep sections), and 11 (Agency & Product Configuration, Executive Dashboard).
- **An operations / teller user**: read documents 0, 4, 7 (Teller/Till, Instrument Register, UNCERTAIN Queue sections), and 10 (Refunds, Recalls, Bulk Payments, Agent/Branchless Banking).
- **Anyone verifying the platform's integrity** (an auditor, or a government reviewer): read document 6, the Audit Explorer section of document 7, and Roles & Permissions in document 11.
- **Anyone who wants the full picture**: read this manual start to finish, in order — each document builds on the concepts introduced before it.

## A note on the demonstration environment

Every screenshot in this manual was taken against the platform's **demonstration dataset**, which is anchored to a fixed date: **30 July 2026 (Asia/Karachi time)**. You'll see this date, labelled "Demo clock," in the header of every screen. This is deliberate — the demo data (payers, bills, cheques, bank statements) is all dated relative to this fixed point, so the numbers you see in this manual will always match what you see if you run the demo yourself, regardless of what today's real date is.

A demonstration environment also includes two controls that a live production environment would not have:
- A **"Run reconciliation"** / **"Run all checks"** style button on several screens, which in production would run automatically on a schedule — it's exposed here so you can trigger it on demand and see the result immediately.
- An internal **reset** function that restores the database to its original seeded state in under ten seconds, so the same walkthrough can be repeated indefinitely without side effects building up.

None of this changes how the underlying business logic works — every calculation, every check, and every state transition shown in this manual is the platform's real, production-equivalent logic operating on real (if synthetic) data.
