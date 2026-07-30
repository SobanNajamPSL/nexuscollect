# NexusCollect — Person-to-Government (P2G) Payment Collection Platform
## Bank-Grade Reference Design & Implementation Specification

**Version:** 1.0
**Date:** 30 July 2026
**Primary market anchor:** Pakistan (SBP / Raast / 1LINK / PRISM+), with a rail-agnostic abstraction layer
**Document purpose:** A single, implementation-ready specification that an AI coding agent can build a working demo platform from, without further design input.

---

## 0. How To Use This Document (read this first, implementing agent)

This document is written to be **executed**, not admired. It is the sole source of truth for the build.

### 0.1 Reading order

| Step | Sections | Why |
|---|---|---|
| 1 | §1–§4 | Scope, glossary, actors, market rails. Establishes vocabulary used everywhere else. |
| 2 | §6–§7 | Canonical domain model and reference/identifier design. **Build the schema before anything else.** |
| 3 | §8 | The 14 collection journeys. These are the acceptance surface. |
| 4 | §9–§12 | State machines, ledger, cash application, reconciliation. The engine. |
| 5 | §13–§17 | Settlement, exceptions, agency config, receipting, APIs. |
| 6 | §18–§23 | Events, NFRs, security, reporting, back-office, DDL. |
| 7 | §24–§27 | Demo data, build phases, test scenarios, open questions. |

### 0.2 Hard rules for the implementation

These are non-negotiable. Violating any one of them produces a demo that a bank or central-bank reviewer will reject on sight.

1. **Money is integer minor units.** Every monetary field is a 64-bit integer of paisa (PKR minor unit, 1 PKR = 100 paisa) plus a separate ISO 4217 currency code. Never use `float`, `double`, or `REAL` for money, anywhere, including in demo data and JSON payloads.
2. **The ledger is append-only.** No `UPDATE` and no `DELETE` on `journal_entry` or `journal_line`. Corrections are contra-entries. Enforce with a database trigger, and write a test that proves the trigger fires.
3. **Every balance is derived, never stored authoritatively.** `assessment.balance_minor` is a materialised cache. A `POST /internal/rebuild-balances` endpoint must recompute every balance from allocations and produce byte-identical results. This is a demo-critical trust signal.
4. **Every state-changing API is idempotent** on an `Idempotency-Key` header. Replaying a request returns the original response body and original HTTP status, and creates no second effect. See §17.4.
5. **Assessment, Payment, and Allocation are three separate things.** Do not put `paid_amount` on the assessment as the primary record of payment, and do not put `assessment_id` on the payment as the primary link. The many-to-many `payment_allocation` table is what makes partial payments, over-payments, one-payment-many-bills, and revenue-head splitting all work with one mechanism. §6.4 explains why. **This is the single most important modelling decision in the document.**
6. **No channel logic in the core.** Channels are adapters. The core domain must not contain `if channel == 'QR'`. If you find yourself writing that, the abstraction in §8.1 is wrong and you should fix the abstraction.
7. **Reconciliation must find the planted breaks.** The demo data pack (§24) contains 11 deliberate reconciliation exceptions of 9 distinct types. The recon engine must find exactly those 11, classify each correctly, and produce the control totals stated in `demo-data/expected-results.json`. Treat that file as a test fixture.
8. **Two-sided time.** Every record carries both a business/value date (`value_date`, a `DATE` in Asia/Karachi) and a system timestamp (`created_at`, a `TIMESTAMPTZ` in UTC). Settlement, cut-offs, and recon operate on `value_date`. Auditing operates on `created_at`. Conflating them is the most common source of month-end breaks in real platforms.

### 0.3 Notation

- `MUST` / `SHOULD` / `MAY` per RFC 2119.
- `[V]` marks a **verified** external fact with a source in §28. If a claim is not traceable to a §28 bullet it must not carry `[V]`.
- `[A]` marks a **design assumption** — industry-typical, plausible, but not verified against a primary source. Anything a real deployment must confirm with SBP, 1LINK, or the agency is marked `[A]` and collected in §27.
- Table column `Card.` = cardinality. `Idem.` = idempotent.

### 0.4 Deliverables in this package

```
P2G-Collection-Platform-Design.md   <- this document (normative)
api/
  openapi.yaml                      <- OpenAPI 3.1 contract for all six API surfaces
scripts/
  generate_demo_data.py             <- deterministic generator; 17 self-checks
demo-data/
  README.md                         load order, conventions, headline figures
  expected-results.json             THE TEST FIXTURE (control totals + planted breaks)
  agencies.csv                      payments.csv
  revenue_heads.csv                 payment_allocations.csv
  reference_schemes.csv             instruments.csv
  products.csv                      requests_to_pay.csv
  payers.csv                        bulk_payment_input.csv
  payer_accounts.csv                bank_statement_camt053.csv
  assessments.csv                   switch_settlement_1link.csv
  assessment_line_items.csv         rail_settlement_raast.csv
  qr-payloads.json                  scroll_fbr_20260730.csv
                                    scroll-sample.txt
```

---

## 1. Scope, Objectives, Non-Goals

### 1.1 What this platform is

**NexusCollect** is a multi-tenant, multi-rail, multi-channel **collection engine** that sits between (a) government agencies that are owed money and (b) every channel through which a citizen or business might pay. It owns the obligation, orchestrates the collection, applies the cash, reconciles the money, and hands the government a clean, signed, head-wise settlement position.

The one-line pitch: **agencies publish what is owed; the platform makes it payable everywhere and provable afterwards.**

### 1.2 Objectives

| # | Objective | Measurable expression |
|---|---|---|
| O1 | Any obligation payable through any channel | One assessment reachable via ≥8 channels with no per-channel agency integration |
| O2 | Single reference works everywhere | One `PSID` resolvable by ATM, app, QR, RtP, OTC teller, agent, biller aggregator |
| O3 | Auto-reconciliation at scale | ≥99.5% of payments auto-matched three-way with zero human touch |
| O4 | Straight-through revenue-head posting | Every rupee lands on a Chart of Accounts revenue head, splittable within one payment |
| O5 | Provable settlement to treasury | Head-wise, agency-wise scroll reconciling to the rupee against the bank statement daily |
| O6 | Bank-grade control | Immutable ledger, maker-checker on every financial adjustment, full audit trail |
| O7 | Real-time payer certainty | Receipt (CPR-equivalent) issued within 3s of payment confirmation, verifiable offline |
| O8 | Peak-day survivability | Tax-deadline surge (§19.3) absorbed without loss of exactly-once semantics |

### 1.3 In scope

- Collection of **taxes** (income, sales, federal excise, customs duty, provincial services sales tax, professional tax), **fines and penalties** (traffic e-challan, regulatory penalties, court fines, late-filing surcharge), **fees and charges** (passport, NADRA, licence, vehicle registration and token tax, court fee, e-stamp duty, utility connection, building plan approval), **bills** (municipal/property tax, water and sanitation, conservancy), and **deposits** (tender/bid security, earnest money, refundable security deposits — which behave differently from revenue; see §15.6).
- Payers: individuals, sole proprietors, AOPs, companies, withholding agents, clearing agents, and third-party payers (someone paying another's bill — a real and commonly-missed requirement, §8.14).
- Channels: authorised push payment, Request to Pay, QR (static and dynamic, merchant-presented and consumer-presented), biller-engine bill inquiry/payment, over-the-counter cash, cheque and pay order, card, wallet, direct debit/mandate, bulk corporate file, agent/branchless banking, and API-embedded (agency portal checkout).
- Supporting functions: reference resolution, cash application, three-way reconciliation, settlement and scroll generation, refunds and reversals, dishonoured-instrument handling, dispute and chargeback, fee and MDR computation with tax-on-fee, notifications, receipting, MIS and regulatory reporting, agency self-service configuration, back-office operations.

### 1.4 Explicitly out of scope

- **Assessment computation.** The platform does not calculate how much tax someone owes. Agencies compute; the platform collects. The platform does compute *derived* amounts under agency-configured rules: late-payment surcharge, instalment schedules, convenience fees, and rounding (§15.4).
- Core banking, card issuing, card acquiring switch functions, and the operation of the national rails themselves.
- Disbursement (G2P). The ledger and rail abstraction are deliberately built so that G2P is an additive phase, not a rewrite — see §26.5.
- Cross-border collection and FX. Currency is modelled but the demo is PKR-only.

### 1.5 Deployment shapes to support

The same codebase must run in three commercial postures, selected per agency by configuration. Getting this right is what makes the platform sellable to both banks and PSOs.

| Shape | Who holds the money in transit | Platform role | Ledger implication |
|---|---|---|---|
| **A. Collector of record** | Platform operator's pooled collection account at a settlement bank | Principal. Receives, holds, sweeps to treasury. | Full asset/liability ledger; the platform owes the agency. Client-money segregation rules apply. |
| **B. Pass-through orchestrator** | Never the platform. Funds move payer's bank → agency's designated account directly on the rail. | Messaging, reference resolution, mandate, receipting, recon. | Off-balance-sheet memo ledger. Platform records obligations and evidences movement but holds no funds. |
| **C. Hybrid per-channel** | Cash/cheque/OTC land in a pooled account (Shape A); rail payments go direct (Shape B). | Both. | Both ledger modes active simultaneously for one agency. **Most realistic and the demo default.** |

> **Implementing agent:** make `agency_settlement_config.model` an enum `COLLECTOR_OF_RECORD | PASS_THROUGH | HYBRID` and drive journal template selection from it (§10.6). Demo agencies must include at least one of each.

---

## 2. Domain Glossary

Use these exact terms in code, database, and UI. Inconsistent vocabulary is how this kind of platform rots.

| Term | Definition | Do not confuse with |
|---|---|---|
| **Agency** | A government entity entitled to collect. Tenant of the platform. | Biller (an agency may expose several biller identities) |
| **Collection Product** | A specific payable thing an agency offers: "Punjab Token Tax – Private Car ≤1000cc". Carries reference scheme, amount rules, revenue head, channel eligibility. | Assessment (an instance of a product owed by a payer) |
| **Assessment** | The authoritative record of an obligation: who owes what, to whom, for what, by when. The demand. | Invoice, bill — these are presentations of an assessment |
| **Payable** | The channel-facing projection of an assessment (or a group of them) returned by reference resolution. | Assessment (internal, richer) |
| **PSID** | Payment Slip Identifier. The single public reference a payer quotes to pay. | Consumer number (a durable account identifier, not per-bill) |
| **Consumer Number / CRN** | A durable identifier of a payer's relationship to a product (e.g. a property tax account, a water connection). Resolves to zero or more open assessments. | PSID (identifies one demand) |
| **Payment Intent** | A payer's declared intention to pay a specific amount against specific payables through a specific channel. Reserves nothing; expires. | Payment (actual money) |
| **Payment** | A record of money that moved. Has a rail reference and a value date. | Allocation (how that money was applied) |
| **Allocation** | The application of some or all of a payment to a specific assessment line item. | Payment |
| **Unapplied Receipt** | Money received that could not be allocated (unknown reference, expired bill, overpayment surplus). Sits in a liability suspense account. | Reconciliation break (a data mismatch, not necessarily stranded money) |
| **Request to Pay (RtP)** | A payee-initiated, payer-authorised pull request. The payee asks; the payer approves; the payer's bank pushes. | Direct debit (pre-authorised, no per-transaction approval) |
| **APP** | Authorised Push Payment. Payer instructs their own bank to push funds. | Pull payment |
| **Rail** | The interbank scheme that moves the money: Raast, 1LINK IBFT, PRISM+, PayPak, card scheme, internal book transfer. | Channel (where the payer stood) |
| **Channel** | The touchpoint the payer used: mobile app, ATM, internet banking, QR, teller, agent, USSD, agency portal, API. | Rail |
| **Instrument** | A physical or quasi-physical payment device: cheque, pay order, demand draft, cash. | Rail |
| **Provisional Credit** | Credit given before finality (e.g. cheque lodged, in clearing). Reversible. | Confirmed credit |
| **Revenue Head** | The Chart of Accounts classification the government books the receipt against (e.g. `B01101` – Income Tax on Companies). | Product (commercial view); a product maps to one or more heads |
| **Scroll** | The itemised daily file a collecting institution sends to the treasury/agency evidencing receipts, head-wise. | Settlement batch (the money movement) |
| **CPR** | Computerized Payment Receipt — the receipt that proves payment to a tax authority. `[A]` Widely used by FBR in Pakistan; the exact required content and who issues it must be confirmed (§27.2 Q12). | Platform receipt (superset; CPR is one rendering) |
| **Break** | A reconciliation exception: a difference between two or more sources of truth. | Dispute (a payer-raised claim) |
| **Cut-off** | The instant after which a payment gets the next business day's value date. | End of day (an operational process) |

---

## 3. Actors, Personas, and Permissions

### 3.1 External actors

| Actor | Interacts via | Key needs |
|---|---|---|
| **Citizen payer** | Bank app, wallet, ATM, QR, OTC, agent, agency portal | Find my bill, pay it once, get proof instantly, never pay twice |
| **Business payer / withholding agent** | Corporate banking, bulk file, API, cheque | Pay 400 challans in one file, split across heads, get one reconcilable receipt set |
| **Third-party payer** | Any channel | Pay someone else's bill without seeing their private data (§8.14) |
| **Agency finance officer** | Agency portal | Did the money arrive, on which head, and does it tie to my ledger? |
| **Agency assessment system** | Server-to-server API | Push assessments, receive payment notifications, cancel/amend demands |
| **Treasury (SBP-BSC / NBP)** `[A]` | Scroll file, settlement instruction | Receipts classified to the Consolidated Fund correctly and on time |
| **Channel institution (bank/EMI/PSP)** | Biller-engine API, rail | Resolve a reference, post a payment, reverse cleanly on timeout |
| **Aggregator (e.g. 1LINK 1BILL)** `[A]` | Bill Inquiry / Bill Payment message set | Standard four-message contract, sub-second response |
| **Regulator (SBP)** | Reports, audit access | Compliance evidence, incident reporting, transaction data |
| **Auditor** | Read-only portal, export | Immutable trail, reperformance of any balance |

### 3.2 Internal roles (RBAC) — seed these exactly

| Role | Can | Cannot | Maker-checker |
|---|---|---|---|
| `PLATFORM_ADMIN` | Manage tenants, roles, config | Touch a financial record directly | n/a |
| `AGENCY_ADMIN` | Configure own agency's products, heads, users | See other agencies' data | Checker for own config |
| `AGENCY_OPERATOR` | Create/amend/cancel own assessments | Change platform config | Maker |
| `OPS_RECON_ANALYST` | Run recon, investigate breaks, propose adjustments | Post adjustments | Maker |
| `OPS_RECON_APPROVER` | Approve/reject adjustments, write-offs | Propose them (segregation of duty) | Checker |
| `OPS_REFUND_MAKER` | Initiate refunds | Approve refunds | Maker |
| `OPS_REFUND_APPROVER` | Approve refunds up to limit; escalate above | Initiate | Checker |
| `TELLER` | Accept OTC cash/cheque, print receipt, reverse within same session | Post adjustments, see other branches | Maker |
| `BRANCH_SUPERVISOR` | Approve teller reversals, close till | Accept payments | Checker |
| `SUPPORT_AGENT` | Read payer/payment records, resend receipt | See full CNIC/PAN, change money | n/a |
| `AUDITOR` | Read everything including audit log; export | Write anything at all | n/a |
| `SERVICE_CHANNEL` | Call resolution + payment APIs for its own institution | Admin APIs, other institutions' data | n/a |

**Rule:** no human role may both propose and approve the same financial adjustment. Enforce at the data layer (`approval.maker_user_id <> approval.checker_user_id`), not only in the UI, and test it.

---

## 4. Market Rails: Pakistan Reference Context

This section grounds the abstraction in real rails. Everything marked `[V]` is sourced in §28; everything `[A]` must be confirmed against the scheme's own participant documentation before a production build.

### 4.1 Raast — SBP's instant payment system

| Attribute | Detail | Status |
|---|---|---|
| Operator | State Bank of Pakistan; underlying system branded Pakistan Faster Payment System (PFPS) | `[V]` |
| Message standard | **ISO 20022** adopted as the messaging standard | `[V]` |
| Availability | **24×7×365** for payments | `[V]` |
| Clearing / settlement | Clearing occurs in Raast; **settlement occurs in PRISM (the RTGS) on a deferred net settlement (DNS) basis via multiple settlement cycles during the business day** | `[V]` |
| Settlement risk model | **Prefunded.** Participants reserve funds in PRISM; a debit cap/limit is extended in Raast against reserved funds, which guarantees settlement | `[V]` |
| Aliasing | **CAS** (Centralised Addressing Scheme) maps a **Raast ID** to an IBAN-standard account. Initially mobile numbers, extending to email, national ID, and eventually free text. No duplicates. A Raast ID may carry an **expiry date** after which it is invalid | `[V]` |
| Alias↔account cardinality | Initially one account ↔ one Raast ID, with intent to broaden | `[V]` |
| Modules and rollout | Phase 3 (Jan 2021): core + **bulk/batch payments**, first use case CDC dividends, then government payments (salaries, pension, social grants). Phase 4 (Feb 2022): **P2P including CAS smart addressing and Request to Pay**. Phase 5 (Nov 2022): **P2M** | `[V]` |
| Request to Pay | Explicitly described as an **overlay service** on the Raast platform, delivered with the P2P phase | `[V]` |
| QR | Raast supports **QR codes** as part of the merchant/business use case | `[V]` |
| Transaction limits | **Raast itself imposes no transaction limits.** Participating financial institutions set limits per channel/customer; direct participants set limits for indirect participants | `[V]` |
| Pricing | Designed on a **cost-recovery** model; SBP aimed to make services free to end users in early phases | `[V]` |
| Participation | Banks and MFBs as **Direct Members**; **government entities as Special Members**; EMIs must arrange access through a member. Non-PRISM-settlement participants must arrange settlement via a Settlement/Direct Member | `[V]` |
| API access | Raast provides APIs to Participants and **designated government entities** | `[V]` |
| Connectivity | Participants connect over MPLS VPN via two different ISPs | `[V]` |
| Channels reachable | Internet, mobile, phone, branches, agent arrangements | `[V]` |
| Specific ISO 20022 message identifiers in use (pacs.008 / pacs.002 / pacs.004 / camt.056 / pain.013 / pain.014) | Not stated in the sources reviewed. **Design against the ISO 20022 canonical set (§4.5) and confirm exact versions and any Raast-specific usage rules with SBP.** | `[A]` |
| RtP expiry windows, decline reason codes, cancellation-request semantics | Not established from public sources | `[A]` |
| A dedicated Raast "P2G / government collections" module distinct from P2M | Government payments are clearly in scope of Raast and government entities are named participants, but a discrete P2G collections module with published rules was not confirmed. **Design P2G as an overlay on P2M + RtP + bulk, which is architecturally safe either way.** | `[A]` |

**Design consequences that follow directly from the verified facts** — these are load-bearing, so implement them deliberately:

1. **DNS with intraday cycles, not RTGS-per-transaction.** A payment can be *final to the payer* in seconds while *interbank settlement* happens later in the day, in a cycle. The platform therefore MUST distinguish `payment.status = CONFIRMED` (rail accepted, payer discharged) from `settlement_batch.status = SETTLED` (funds netted in PRISM). Reconciliation is against the **cycle**, not the transaction. Model `settlement_cycle` as a first-class entity (§13.2).
2. **24×7 rail vs. banking-day treasury.** The rail never sleeps; the government's accounting day does. Value-date assignment and cut-off logic (§13.3) are mandatory, not optional. A payment at 23:55 on 30 June is a different fiscal year from one at 00:05 on 1 July — and for tax deadlines this is the single most litigated fact in the system. Store the cut-off decision and the rule version that produced it on the payment record.
3. **No scheme-level limits means the platform is the limit authority.** Because Raast imposes none, per-product, per-channel, per-payer, and per-institution limits must be enforced in the platform (§19.4) with a clear, auditable precedence order.
4. **Government entities as Special Members** means an agency may be *directly* addressable on the rail. Shape B (pass-through, §1.5) is therefore genuinely achievable, not theoretical. Do not build a design that assumes funds must transit the platform.
5. **Alias expiry is a real state.** `raast_id` resolution can fail for an ID that resolved yesterday. Handle `ALIAS_EXPIRED` as a distinct, non-retryable resolution outcome with its own payer-facing message.
6. **Aliases will broaden to national ID.** Since CAS is intended to extend to national IDs, design alias resolution as `(alias_type, alias_value)` from day one — never as a bare mobile-number column.

### 4.2 1LINK / 1BILL — the biller aggregation model

| Attribute | Detail | Status |
|---|---|---|
> **Source note.** No 1LINK primary source could be retrieved in preparing this document, so **every row in this table is `[A]`** — industry-typical and consistent with how the platform must be built, but not verified. Confirm all of it against 1LINK's own participant and integration documentation before a production build (§27.1 Q7–Q8). The *design consequences* below are robust regardless, because they describe the contract the platform must expose.

| Attribute | Detail | Status |
|---|---|---|
| Operator | 1LINK (Guarantee) Limited, Pakistan's principal domestic switch; also associated with the PayPak scheme and IBFT | `[A]` |
| 1BILL | 1LINK's bill payment / invoice-voucher aggregation service, connecting billers to member banks' channels | `[A]` |
| Core message pattern | An inquiry/payment message pair with reversal and advice. Model the classic four: **Bill Inquiry**, **Bill Payment**, **Bill Payment Reversal**, **Bill Payment Advice/Confirmation** | `[A]` — the near-universal biller-switch contract; exact field names, ISO 8583 bitmap positions and response codes must come from the 1LINK integration specification |
| Reference model | Consumer number and/or PSID/voucher identifier presented by the payer, validated by the biller in real time | `[A]` |
| Consuming channels | ATM, mobile banking, internet banking, over-the-counter, and agent/branchless networks | `[A]` |

**Design consequence.** The platform MUST expose a **switch-facing biller interface** implementing the four-message contract with the following properties, because this is the contract that lets one integration light up every bank in the country:

- **Bill Inquiry** is a pure read, sub-second, safe to retry, and MUST NOT create state that blocks a later payment. It MAY create a short-lived quote (§8.4) but the quote must never be a lock that can strand a bill.
- **Bill Payment** is the money message. It MUST be idempotent on the switch's transaction identifier (STAN/RRN + acquirer + date) — not on the platform's own key, because the switch will not send yours.
- **Reversal** MUST be accepted for a configurable window and MUST be *safe against a payment the platform never saw* (a "reversal without original" — a real and frequent condition when the original timed out on the switch side). Store it as a `PENDING_REVERSAL` awaiting the late original, and auto-match on arrival. This single behaviour separates a serious biller integration from a naive one.
- **Advice** carries late confirmations and MUST resolve `UNCERTAIN` payments (§9.4).

### 4.3 PRISM+ — RTGS

`[V]` PRISM (Pakistan Real-time Interbank Settlement Mechanism) is Pakistan's RTGS, and SBP presents **PRISM+** as current payment infrastructure. Raast settles in PRISM. `[A]` For the collection platform, PRISM is relevant in three ways: (a) it is where the DNS net position of Raast lands; (b) large single corporate tax payments may be instructed directly as RTGS transfers, which the platform must be able to ingest and match; (c) sweeps from a pooled collection account to a treasury account will typically be RTGS.

Implement an `RTGS_CREDIT` inbound channel: high-value, low-volume, arrives as a MT103-equivalent/pacs.008-equivalent credit advice or a statement line, frequently with a **free-text remittance field the payer has filled in badly**. Reference extraction from unstructured remittance text is therefore a required feature, not a nice-to-have (§11.6).

### 4.4 Government collection landscape (reference use cases)

Concrete Pakistani collection streams the demo should represent. Treat the mechanics as `[A]` unless marked otherwise, and treat the *shape* of each as the design requirement rather than the exact digit counts.

| Stream | Owner | Reference | Notable mechanics |
|---|---|---|---|
| Income tax, sales tax, federal excise | FBR (systems by PRAL) | **PSID** → **CPR** on payment `[A]` | Payer creates a PSID in the tax portal, then pays through any bank channel; CPR is the proof used in filings. Head-wise classification is mandatory. |
| Customs duty and taxes | FBR / Pakistan Single Window / WeBOC | Goods declaration reference → PSID | **Payment gates release of cargo.** Latency and certainty matter more than anywhere else in the system: a slow confirmation costs demurrage. Requires a synchronous, authoritative "is it paid?" API. |
| Provincial services sales tax | PRA (Punjab), SRB (Sindh), KPRA, BRA | Own challan/PSID | Separate tenants, separate treasuries, overlapping payers. Multi-tenancy is not cosmetic. |
| Stamp duty | Punjab e-Stamping and equivalents | e-Stamp reference | **Payment precedes issuance of a legal instrument**; the artefact must be non-repudiable and verifiable by a third party years later. |
| Traffic e-challan | Provincial police / safe-city authorities | Challan number, vehicle registration, CNIC | Payer often knows only the **vehicle number**, not the challan. Requires reference resolution by a non-reference attribute returning *many* payables. Discounts for early payment and escalating penalties are common. |
| Motor vehicle token tax, registration | Excise & Taxation departments | Vehicle registration number | Annual, recurring, resolvable by vehicle. Ideal RtP and standing-instruction candidate. |
| Property tax, water, conservancy | Local government / WASAs | **Consumer number** (durable) | Arrears ageing, instalments, partial payment, oldest-first application. |
| Court fees, fines | Judiciary | Case number | Payment must be linked back to a case file; often paid by a third party (a lawyer). |
| Passport, NADRA, licences, e-services | Interior / NADRA / departments | Application/token number | Fee is fixed, payment gates the service, high volume, short-lived reference. |
| Tender/bid security, earnest money | All agencies | Tender reference | **Refundable deposit, not revenue.** Different accounting (liability, not income), different lifecycle, expects a refund. See §15.6. |

`[A]` The funds-flow architecture the platform must serve: a collecting bank receives money, the money is accounted to a government account (in Pakistan, the treasury banking function sits with National Bank of Pakistan and SBP Banking Services Corporation, and receipts are classified to the Federal or a Provincial Consolidated Fund), and the collecting institution transmits an itemised **scroll** that the agency and the Accountant General reconcile against. **Confirm the exact account structures, scroll formats, and cut-off times with the treasury and agency before production.** The platform's obligation is to produce a head-wise, agency-wise, date-wise itemised scroll that ties to the rupee against the bank statement (§13.5), which is a stable requirement regardless of the specific account names.

### 4.5 Canonical ISO 20022 message set for this platform

Build the internal canonical model on ISO 20022 semantics and map each rail to it with an adapter. Where a rail's exact message version is unconfirmed, the adapter is where that uncertainty lives — the core stays clean.

| Message | Purpose in this platform | Where used |
|---|---|---|
| `pain.013` CreditorPaymentActivationRequest | **The RtP itself.** Payee asks payer to authorise a payment. | §8.3 RtP initiation |
| `pain.014` CreditorPaymentActivationRequestStatusReport | RtP status: accepted, declined, expired, pending. | §8.3 RtP lifecycle |
| `pacs.008` FIToFICustomerCreditTransfer | The inbound credit transfer that actually pays a bill. | APP, RtP fulfilment, QR-initiated push |
| `pacs.002` FIToFIPaymentStatusReport | Accept/reject status of a credit transfer. | Confirmation, `UNCERTAIN` resolution |
| `pacs.004` PaymentReturn | Return of funds (wrong beneficiary, closed account, agency rejection). | §14 returns |
| `pacs.028` FIToFIPaymentStatusRequest | **Status enquiry for a payment with no response.** Critical for timeout handling. | §9.4 investigation |
| `camt.056` FIToFIPaymentCancellationRequest | Request to cancel/recall a payment. | §14.4 recall |
| `camt.029` ResolutionOfInvestigation | Outcome of a cancellation or investigation. | §14.4 |
| `camt.052` BankToCustomerAccountReport | Intraday account report. | Intraday recon, §12.3 |
| `camt.053` BankToCustomerStatement | **End-of-day bank statement — the third leg of three-way recon.** | §12.3 (demo: `bank_statement_camt053.csv`) |
| `camt.054` BankToCustomerDebitCreditNotification | Real-time credit notification. Enables near-real-time cash application. | §11 |
| `pain.001` / `pain.002` | Outbound payment initiation and status — used for **refunds and sweeps**, not collection. | §14.1, §13.4 |
| `remt.001` RemittanceAdvice | Standalone remittance advice where the rail's remittance field is too small to carry the allocation detail. | Bulk corporate payments, §8.10 |
| ISO 11649 **RF Creditor Reference** | Structured, check-digit-protected creditor reference. **The mechanism that makes auto-reconciliation possible.** | §7.4 |

**Key identifiers to carry end-to-end and never lose:**

| Field | Meaning | Platform rule |
|---|---|---|
| `EndToEndId` | Assigned by the initiating party, survives the whole chain unchanged | Carry the platform's `payment_reference` here. This is the primary auto-match key. |
| `TxId` | Assigned by the initiating FI | Store as `rail_txn_id`; secondary match key. |
| `UETR` | UUIDv4 unique end-to-end transaction reference | Store when the rail provides it; best cross-institution investigation key. |
| `InstrId` | Instruction ID, point-to-point only | Store, but never rely on for matching across hops. |
| `RmtInf/Strd/CdtrRefInf/Ref` | Structured creditor reference | Where the PSID lives when the rail supports structured remittance. |
| `RmtInf/Ustrd` | Unstructured remittance text | Where the PSID lives when it does not. Parse defensively (§11.6). |

---

## 5. Capability Map

Twelve capability domains. Each maps to a service boundary; the demo may deploy them as one modular monolith (recommended — see §22.6) but the boundaries must be visible in the code structure.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  C1 AGENCY & PRODUCT CONFIGURATION                                         │
│  tenants · products · reference schemes · revenue heads · fees · limits     │
│  channel eligibility · calendars & cut-offs · settlement model             │
├────────────────────────────────────────────────────────────────────────────┤
│  C2 OBLIGATION MANAGEMENT           │  C3 REFERENCE RESOLUTION             │
│  assessment intake (API/file/portal)│  resolve ANY reference → payable(s)   │
│  amendment · cancellation · expiry  │  PSID · CRN · CNIC · NTN · vehicle    │
│  arrears ageing · instalment plans  │  case no · QR payload · alias         │
│  surcharge accrual                  │  masking & privacy · rate limiting    │
├─────────────────────────────────────┼──────────────────────────────────────┤
│  C4 PAYMENT INITIATION & CAPTURE    │  C5 REQUEST-TO-PAY ORCHESTRATION      │
│  intent · quote · authorisation     │  single & bulk RtP · reminders        │
│  APP · QR · biller msgs · OTC       │  expiry · decline · cancel · amend    │
│  card · wallet · mandate · bulk file│  mandate-backed recurring collection  │
├─────────────────────────────────────┼──────────────────────────────────────┤
│  C6 INSTRUMENT MANAGEMENT           │  C7 LEDGER & CASH APPLICATION         │
│  cheque/PO/DD lodgement & linking   │  double-entry journal (append-only)   │
│  clearing lifecycle · dishonour     │  allocation engine · waterfall rules  │
│  provisional credit & reversal      │  unapplied receipts · over/under      │
│  cash till · teller batch · scroll  │  head-wise splitting · FX (future)    │
├─────────────────────────────────────┼──────────────────────────────────────┤
│  C8 RECONCILIATION                  │  C9 SETTLEMENT & TREASURY             │
│  3-way & N-way matching             │  cycle capture · netting · fees       │
│  break taxonomy · ageing · SLA      │  sweep instruction · scroll generation│
│  adjustment workflow (maker-checker)│  treasury confirmation · head mapping │
│  auto write-off thresholds          │  fiscal-year & period close           │
├─────────────────────────────────────┼──────────────────────────────────────┤
│  C10 EXCEPTIONS & LIFECYCLE         │  C11 EVIDENCE & NOTIFICATION          │
│  reversal · refund · recall         │  receipt/CPR generation & signing     │
│  return · dispute · chargeback      │  verification portal & offline QR     │
│  dishonour · duplicate detection    │  SMS/email/push/webhook · templating  │
├─────────────────────────────────────┴──────────────────────────────────────┤
│  C12 CROSS-CUTTING                                                          │
│  identity & RBAC · maker-checker · audit · idempotency · limits & velocity  │
│  fraud & AML screening · observability · MIS & regulatory reporting · DR    │
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Capability → priority for the demo

| Capability | Demo priority | Rationale |
|---|---|---|
| C3 Reference Resolution | **P0** | It is the thing that makes the demo feel magic: one reference, every channel. |
| C7 Ledger & Cash Application | **P0** | The credibility core. Reviewers will try to break it. |
| C8 Reconciliation | **P0** | The named requirement, and the hardest to fake. |
| C4 Payment Initiation | **P0** | Needs at least APP, QR, biller, OTC live. |
| C5 RtP | **P0** | Explicitly requested; also the most impressive to demo live. |
| C2 Obligation Management | **P0** | Nothing works without assessments. |
| C6 Instruments (cheque) | **P1** | Explicitly requested; implement lodgement → clearing → one dishonour. |
| C9 Settlement & Scroll | **P1** | Closes the loop to government. One good scroll is worth ten screens. |
| C11 Receipting | **P1** | Cheap to build, high perceived value, enables the offline-verify party trick. |
| C10 Exceptions | **P1** | Implement refund + reversal + dishonour; stub chargeback. |
| C1 Configuration | **P1** | Enough to prove multi-tenancy and no-code product onboarding. |
| C12 Cross-cutting | **P0 for idempotency/audit/RBAC**, P2 for fraud/AML | Idempotency and audit are non-negotiable even in a demo. |
---

## 6. Canonical Domain Model

### 6.1 Entity relationship overview

```
                          ┌──────────┐
                          │  AGENCY  │ (tenant)
                          └────┬─────┘
             ┌─────────────────┼──────────────────┬─────────────────┐
             ▼                 ▼                  ▼                 ▼
      ┌────────────┐   ┌──────────────┐   ┌──────────────┐  ┌──────────────┐
      │ REVENUE    │   │  COLLECTION  │   │  SETTLEMENT  │  │   AGENCY     │
      │ HEAD (COA) │   │   PRODUCT    │   │    CONFIG    │  │    USER      │
      └─────┬──────┘   └──────┬───────┘   └──────────────┘  └──────────────┘
            │                 │  1─┐
            │                 │    └──► REFERENCE_SCHEME, FEE_SCHEDULE, LIMIT_PROFILE
            │                 ▼
   ┌────────┴───────┐  ┌─────────────┐        ┌────────┐
   │                └─►│ ASSESSMENT  │◄───────│ PAYER  │
   │                   │  (PSID)     │        └───┬────┘
   │                   └──┬───┬───┬──┘            │
   │                      │   │   │               │ ┌──────────────┐
   │   ┌──────────────────┘   │   └───────────┐   └►│ PAYER_ACCOUNT │ (CRN)
   │   ▼                      ▼               ▼     └──────────────┘
   │ ┌──────────────────┐ ┌────────────┐ ┌──────────────┐
   └►│ ASSESSMENT_LINE  │ │ INSTALMENT │ │ REQUEST_TO_PAY│
     │  _ITEM  (head)   │ │  _PLAN     │ └──────┬───────┘
     └────────┬─────────┘ └────────────┘        │
              │                                  │
              │      ┌───────────────┐           │
              │      │PAYMENT_INTENT │◄──────────┘
              │      └───────┬───────┘
              │              ▼
              │        ┌──────────┐        ┌────────────┐
              │        │ PAYMENT  │◄───────│ INSTRUMENT │ (cheque/PO/DD/cash)
              │        └────┬─────┘        └────────────┘
              │             │  │
              └───────►┌────▼──────────────┐
                       │PAYMENT_ALLOCATION │ ── the cash-application join
                       └────┬──────────────┘
                            │
        ┌───────────────────┼────────────────────┬──────────────┐
        ▼                   ▼                    ▼              ▼
 ┌─────────────┐   ┌────────────────┐   ┌──────────────┐ ┌──────────┐
 │JOURNAL_ENTRY│   │SETTLEMENT_BATCH│   │   RECEIPT    │ │  REFUND  │
 │ + LINES     │   │ + SCROLL       │   │   (CPR)      │ │/REVERSAL │
 └─────────────┘   └────────────────┘   └──────────────┘ └──────────┘

        ┌──────────────────────────────────────────────────┐
        │ RECON_RUN → RECON_SOURCE_RECORD → RECON_MATCH     │
        │                                 → RECON_BREAK    │
        │                                 → ADJUSTMENT     │
        └──────────────────────────────────────────────────┘
```

### 6.2 Entity: `agency`

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `code` | VARCHAR(12) UNIQUE | Short stable code, e.g. `FBR`, `PRA`, `ETPB`, `PSCA` |
| `name` | VARCHAR(200) | |
| `tier` | ENUM | `FEDERAL \| PROVINCIAL \| LOCAL \| AUTONOMOUS_BODY \| JUDICIAL` |
| `jurisdiction` | VARCHAR(50) | e.g. `PK`, `PK-PB`, `PK-SD`, `PK-LHR` |
| `legal_entity_name` | VARCHAR(200) | For scroll headers and legal artefacts |
| `treasury_account_iban` | VARCHAR(34) | Destination for swept/direct funds |
| `treasury_bank_bic` | VARCHAR(11) | |
| `consolidated_fund_ref` | VARCHAR(50) | `[A]` Government account classification reference |
| `settlement_model` | ENUM | `COLLECTOR_OF_RECORD \| PASS_THROUGH \| HYBRID` (§1.5) |
| `timezone` | VARCHAR(40) | Default `Asia/Karachi` |
| `fiscal_year_start_month` | SMALLINT | `[A]` 7 for Pakistan (July–June) |
| `status` | ENUM | `DRAFT \| ACTIVE \| SUSPENDED \| CLOSED` |
| `onboarded_at` | TIMESTAMPTZ | |

### 6.3 Entity: `collection_product`

The product is the configuration surface that lets a new collection stream go live **without code**. Getting this rich enough is what turns a demo into a platform.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `agency_id` | FK | |
| `code` | VARCHAR(30) | Unique within agency, e.g. `PB-TOKEN-CAR-1000` |
| `name` | VARCHAR(200) | Payer-facing |
| `category` | ENUM | `TAX \| DUTY \| FINE \| PENALTY \| FEE \| BILL \| STAMP \| DEPOSIT \| MISC` |
| `reference_scheme_id` | FK | How PSIDs are formed/validated (§7) |
| `secondary_lookup_keys` | JSONB | Ordered list of alternative resolution keys, e.g. `["VEHICLE_REG","CNIC"]` |
| `amount_rule` | ENUM | `FIXED \| ASSESSED \| OPEN \| MIN_MAX` — see below |
| `fixed_amount_minor` | BIGINT NULL | When `FIXED` |
| `min_amount_minor` / `max_amount_minor` | BIGINT NULL | When `OPEN`/`MIN_MAX` |
| `allow_partial` | BOOLEAN | Partial payment permitted |
| `min_partial_pct` | NUMERIC(5,2) NULL | e.g. 25.00 = at least 25% per instalment |
| `allow_overpayment` | BOOLEAN | |
| `overpay_treatment` | ENUM | `REJECT \| CREDIT_ON_ACCOUNT \| AUTO_REFUND \| ABSORB` |
| `underpay_tolerance_minor` | BIGINT | Below-this shortfall treated as settled in full (rounding relief) |
| `overpay_tolerance_minor` | BIGINT | Above-this surplus routed per `overpay_treatment` |
| `rounding_rule` | ENUM | `NONE \| NEAREST_1 \| NEAREST_10 \| UP_1 \| UP_10` |
| `allowed_channels` | VARCHAR[] | e.g. `{APP,QR,RTP,BILLER,OTC_CASH,CHEQUE,CARD,WALLET}` |
| `allowed_instruments` | VARCHAR[] | Cheque may be disallowed for fines, for example |
| `expiry_rule` | JSONB | `{"type":"DAYS_FROM_ISSUE","days":30}` or `{"type":"FIXED_DATE"}` or `{"type":"NEVER"}` |
| `surcharge_rule` | JSONB NULL | §15.4 late-payment accrual definition |
| `early_discount_rule` | JSONB NULL | e.g. traffic challan −25% if paid within 10 days |
| `fee_schedule_id` | FK NULL | Convenience fee / MDR (§15.5) |
| `fee_bearer` | ENUM | `PAYER \| AGENCY \| SPLIT` |
| `default_revenue_head_id` | FK | Fallback COA head |
| `allocation_waterfall` | ENUM | `OLDEST_FIRST \| PENALTY_FIRST \| PRINCIPAL_FIRST \| PRO_RATA \| EXPLICIT_ONLY` (§11.3) |
| `requires_payer_identification` | BOOLEAN | Some fines are payable anonymously; taxes are not |
| `service_gating` | ENUM | `NONE \| BLOCKS_SERVICE \| RELEASES_GOODS` | Drives confirmation latency SLO (§19.2) |
| `deposit_refundable` | BOOLEAN | True for `DEPOSIT` category (§15.6) |
| `receipt_template_id` | FK | |
| `status` | ENUM | `DRAFT \| ACTIVE \| SUSPENDED \| RETIRED` |
| `effective_from` / `effective_to` | DATE | Versioned config |

**`amount_rule` semantics:**

| Value | Meaning | Example |
|---|---|---|
| `FIXED` | Amount is a product constant; assessment need not carry one | Passport fee |
| `ASSESSED` | Agency supplies the amount on the assessment | Income tax demand |
| `OPEN` | Payer chooses the amount within bounds | Voluntary advance tax deposit |
| `MIN_MAX` | Payer chooses within an assessed floor/ceiling | Instalment of a property tax arrear |

### 6.4 Entity: `assessment` — and why it is separate from payment

This is the heart of the model. Read this before coding anything.

A naive design puts `amount_paid` and `status` on a bill and calls it done. That design fails the moment reality shows up:

- one payment pays five challans (a fleet owner clearing tickets);
- one bill is paid by three payments (instalments);
- a payment overpays and the surplus must sit somewhere real;
- a payment must be split across four revenue heads because the government books income tax, surcharge, and penalty separately;
- a cheque provisionally settles a bill and then bounces three days later, and the bill must revert without losing history;
- a payment arrives with a garbled reference and must sit unapplied for two days before an analyst applies it.

Every one of those is the same operation — **allocating money to obligations** — and a many-to-many `payment_allocation` table handles all of them with one code path. `amount_paid` on the bill handles none of them.

```
assessment (what is owed)  ──┐
                             ├──► payment_allocation (how money was applied) ◄── payment (money that moved)
assessment_line_item (head)──┘
```

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `psid` | VARCHAR(30) UNIQUE | The public reference. Indexed, case-normalised. |
| `agency_id` | FK | |
| `product_id` | FK | |
| `payer_id` | FK NULL | Null for anonymous-payable products |
| `payer_account_id` | FK NULL | Durable CRN relationship, if any |
| `payer_snapshot` | JSONB | **Immutable copy** of payer name/ID at issue time. Never join to live payer data for a receipt — the payer may have been renamed. |
| `external_ref` | VARCHAR(80) | Agency's own key (challan no, case no, GD no) |
| `description` | VARCHAR(300) | Payer-facing, e.g. "Token Tax 2026-27 — LEA-17-1000" |
| `currency` | CHAR(3) | `PKR` |
| `assessed_amount_minor` | BIGINT | Sum of line items at issue |
| `surcharge_accrued_minor` | BIGINT | Derived, recomputed on read (§15.4) |
| `discount_applied_minor` | BIGINT | |
| `payable_amount_minor` | BIGINT | **Derived:** assessed − discount. Surcharge is already inside `assessed` as a line item — see the invariant note below. |
| `allocated_amount_minor` | BIGINT | **Derived cache** from allocations, rebuildable |
| `balance_minor` | BIGINT | **Derived cache:** payable − allocated |
| `issue_date` | DATE | |
| `due_date` | DATE | Surcharge starts after this |
| `expiry_date` | DATE NULL | After this the PSID is not payable |
| `status` | ENUM | §9.1 state machine |
| `allow_partial_override` | BOOLEAN NULL | Per-assessment override of product default |
| `service_gate_token` | VARCHAR(60) NULL | Token the agency's service system checks |
| `source` | ENUM | `AGENCY_API \| AGENCY_FILE \| AGENCY_PORTAL \| PLATFORM_ADHOC \| MIGRATION` |
| `version` | INTEGER | Optimistic lock; incremented on amendment |
| `metadata` | JSONB | Agency-specific fields (vehicle reg, tax year, case no) — **searchable, see §7.5** |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**Invariants (enforce as DB constraints or triggers, and test each):**

- `payable_amount_minor = assessed_amount_minor - discount_applied_minor`
  > **Why surcharge is not added here.** Accrued surcharge is *materialised as a `SURCHARGE` line item inside* `assessed_amount_minor`, because `Σ line items = assessed` must hold and the surcharge has to sit on its own revenue head to be settleable. `surcharge_accrued_minor` is therefore a **denormalised copy** of the surcharge line total, kept for reporting convenience, not an additional amount. Adding it again would double-count. Enforce `surcharge_accrued_minor = Σ(line_item WHERE line_type='SURCHARGE')` as a separate constraint.
- `allocated_amount_minor = SUM(payment_allocation.amount_minor WHERE assessment_id = this AND status='APPLIED')`
- `balance_minor = payable_amount_minor - allocated_amount_minor`
- `balance_minor >= 0` unless `product.allow_overpayment` and `overpay_treatment='ABSORB'`
- `SUM(assessment_line_item.amount_minor) = assessed_amount_minor`
- `status='SETTLED'` ⟺ `balance_minor <= product.underpay_tolerance_minor`

### 6.5 Entity: `assessment_line_item`

Why this exists: the government does not receive "PKR 50,000 of tax". It receives PKR 42,000 of income tax on companies, PKR 6,000 of default surcharge, and PKR 2,000 of penalty, each against a different Chart of Accounts head, each reported separately. **A single payment must be splittable across heads deterministically** — and when the payment is partial, the split must follow a defined waterfall, not an accident of row order.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `assessment_id` | FK | |
| `seq` | SMALLINT | Display and waterfall order |
| `line_type` | ENUM | `PRINCIPAL \| SURCHARGE \| PENALTY \| INTEREST \| FEE \| TAX_ON_FEE \| ROUNDING \| ARREAR` |
| `revenue_head_id` | FK | The COA head this line credits |
| `tax_period` | VARCHAR(20) NULL | e.g. `2025-26`, `2026-Q1`, `2026-07` — **arrears require period-level granularity** |
| `description` | VARCHAR(200) | |
| `amount_minor` | BIGINT | |
| `allocated_minor` | BIGINT | Derived cache |
| `allocation_priority` | SMALLINT | Lower = paid first under the waterfall |

### 6.6 Entity: `payer` and `payer_account`

| `payer` field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `payer_type` | ENUM | `INDIVIDUAL \| SOLE_PROPRIETOR \| AOP \| COMPANY \| GOVERNMENT \| NON_RESIDENT` |
| `primary_id_type` | ENUM | `CNIC \| NICOP \| PASSPORT \| NTN \| STRN \| FTN \| INCORPORATION_NO` |
| `primary_id_value_enc` | BYTEA | **Encrypted at rest.** Deterministic encryption or a keyed hash so it remains searchable (§20.4) |
| `primary_id_last4` | CHAR(4) | For display and support lookup without decryption |
| `name` | VARCHAR(200) | |
| `msisdn_e164` | VARCHAR(20) NULL | Also the likely Raast ID |
| `email` | VARCHAR(200) NULL | |
| `raast_id_type` / `raast_id_value` | VARCHAR | `[V]` alias types: `MSISDN \| EMAIL \| NATIONAL_ID \| FREE_TEXT` |
| `raast_id_expires_on` | DATE NULL | `[V]` aliases can expire |
| `kyc_level` | ENUM | `NONE \| BASIC \| FULL` |
| `risk_rating` | ENUM | `LOW \| MEDIUM \| HIGH` |
| `status` | ENUM | `ACTIVE \| DORMANT \| BLOCKED` |

`payer_account` is the **durable relationship** that makes consumer-number lookups work (property tax account, water connection, vehicle):

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `payer_id` | FK NULL | May be unknown initially (a vehicle exists before you know its owner) |
| `agency_id` / `product_id` | FK | |
| `crn` | VARCHAR(30) | Consumer reference number, unique per agency |
| `account_label` | VARCHAR(200) | "House 12, Street 4, Model Town" |
| `attributes` | JSONB | `{"vehicle_reg":"LEA-17-1000","engine_cc":1300}` |
| `arrears_balance_minor` | BIGINT | Derived from open assessments |
| `status` | ENUM | `ACTIVE \| CLOSED \| DISCONNECTED` |

### 6.7 Entity: `payment_intent`

An intent is a **quote plus a promise**, not a reservation. It exists so that (a) the amount and fees the payer was shown are provable later, (b) a payment arriving on a rail can be matched to what the payer intended, and (c) duplicate submissions collapse.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `intent_reference` | VARCHAR(24) UNIQUE | Public, quoted on the rail as `EndToEndId` |
| `channel` | ENUM | §8.1 |
| `initiating_institution_id` | FK NULL | Bank/EMI/PSP that raised it |
| `payer_id` | FK NULL | |
| `third_party_payer` | JSONB NULL | §8.14 |
| `requested_amount_minor` | BIGINT | What the payer chose to pay |
| `fee_amount_minor` | BIGINT | Computed at quote time |
| `tax_on_fee_minor` | BIGINT | `[A]` provincial sales tax on services may apply to the fee |
| `total_debit_minor` | BIGINT | requested + fee + tax_on_fee (when `fee_bearer=PAYER`) |
| `currency` | CHAR(3) | |
| `quote_expires_at` | TIMESTAMPTZ | Typically 15 min `[A]` |
| `status` | ENUM | §9.3 |
| `idempotency_key` | VARCHAR(64) | Client-supplied |
| `requested_allocations` | JSONB | Optional explicit `[{assessment_id, amount_minor}]` — payer chose the split |
| `created_at` | TIMESTAMPTZ | |

### 6.8 Entity: `payment`

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `payment_reference` | VARCHAR(24) UNIQUE | Platform's own reference; goes on the receipt and in `EndToEndId` |
| `intent_id` | FK NULL | Null for unsolicited credits (a payer just pushed funds with a PSID in the narrative) |
| `agency_id` | FK NULL | Null until allocated (an unapplied receipt has no agency yet) |
| `channel` | ENUM | Where the payer stood |
| `rail` | ENUM | `RAAST \| IBFT_1LINK \| PRISM_RTGS \| PAYPAK \| CARD_SCHEME \| INTERNAL_BOOK \| CASH \| CHEQUE_CLEARING \| WALLET` |
| `direction` | ENUM | `INBOUND` (collection) / `OUTBOUND` (refund, sweep) |
| `instrument_id` | FK NULL | Cheque/PO/DD/cash-till link |
| `gross_amount_minor` | BIGINT | Money that moved |
| `fee_amount_minor` | BIGINT | Deducted or added per `fee_bearer` |
| `net_to_agency_minor` | BIGINT | gross − agency-borne fees |
| `currency` | CHAR(3) | |
| `status` | ENUM | §9.4 |
| `finality` | ENUM | `PROVISIONAL \| FINAL` — cheques are provisional until cleared |
| `value_date` | DATE | **Business date. Drives settlement and recon.** |
| `received_at` | TIMESTAMPTZ | System time of receipt |
| `confirmed_at` | TIMESTAMPTZ NULL | When it became payer-final |
| `rail_e2e_id` | VARCHAR(35) | ISO 20022 `EndToEndId` |
| `rail_txn_id` | VARCHAR(35) NULL | `TxId` |
| `rail_uetr` | UUID NULL | |
| `rail_instr_id` | VARCHAR(35) NULL | Point-to-point only |
| `switch_stan` | VARCHAR(12) NULL | ISO 8583 STAN, for switch-originated payments |
| `switch_rrn` | VARCHAR(20) NULL | Retrieval reference number |
| `acquirer_id` | VARCHAR(20) NULL | |
| `payer_account_masked` | VARCHAR(40) NULL | e.g. `PK**...**3421` |
| `payer_bank_bic` | VARCHAR(11) NULL | |
| `remittance_raw` | TEXT NULL | **Keep the original, unparsed.** Essential for investigating a bad match. |
| `settlement_batch_id` | FK NULL | |
| `unapplied_amount_minor` | BIGINT | gross − allocated; > 0 means money is stranded |
| `duplicate_of_payment_id` | FK NULL | Set by duplicate detection (§14.5) |
| `created_at` | TIMESTAMPTZ | |

**Unique constraints that prevent double-posting** (build all four; each has caught a real bug in a real platform):

1. `UNIQUE (rail, rail_e2e_id)` where `rail_e2e_id IS NOT NULL`
2. `UNIQUE (rail, switch_stan, switch_rrn, acquirer_id, value_date)` where switch fields present
3. `UNIQUE (intent_id)` where `intent_id IS NOT NULL AND status NOT IN ('REVERSED','FAILED')` — one intent yields at most one live payment
4. `UNIQUE (instrument_id)` where `instrument_id IS NOT NULL`

### 6.9 Entity: `payment_allocation` — the cash-application join

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `payment_id` | FK | |
| `assessment_id` | FK | |
| `line_item_id` | FK | **Head-level.** Allocation is always to a line item, never merely to an assessment. |
| `revenue_head_id` | FK | Denormalised for reporting speed; must equal `line_item.revenue_head_id` |
| `amount_minor` | BIGINT | > 0 |
| `allocation_basis` | ENUM | `EXPLICIT` (payer/agency chose) `\| WATERFALL` (engine applied rules) `\| MANUAL` (analyst applied) `\| SYSTEM_REALLOCATION` |
| `status` | ENUM | `APPLIED \| REVERSED` |
| `applied_at` | TIMESTAMPTZ | |
| `reversed_at` | TIMESTAMPTZ NULL | |
| `reversal_reason` | VARCHAR(60) NULL | `CHEQUE_RETURNED`, `PAYMENT_RECALLED`, `MISALLOCATION`, `DUPLICATE` |
| `applied_by_user_id` | FK NULL | Non-null only when `MANUAL` |
| `approval_id` | FK NULL | Maker-checker record for `MANUAL` and `SYSTEM_REALLOCATION` |

**Invariant:** `SUM(allocation.amount_minor WHERE payment_id = P AND status='APPLIED') + payment.unapplied_amount_minor = payment.gross_amount_minor` — for every payment in a live state (`CONFIRMED`, `PARTIALLY_REVERSED`), at every instant. Fully `REVERSED` payments have zero on both sides of the equation and `UNCERTAIN` payments have not been applied yet; both are legitimately excluded, and the control that checks this (§10.8) must name its exclusion set rather than skip rows quietly. Assert this in a scheduled integrity check and expose the result on the ops dashboard. It is the cheapest possible proof that the platform is sound.

### 6.10 Entity: `request_to_pay`

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `rtp_reference` | VARCHAR(24) UNIQUE | |
| `agency_id` | FK | |
| `assessment_ids` | UUID[] | An RtP may cover several assessments |
| `payer_id` | FK NULL | |
| `payer_alias_type` | ENUM | `MSISDN \| EMAIL \| NATIONAL_ID \| IBAN \| FREE_TEXT` |
| `payer_alias_value` | VARCHAR(120) | |
| `resolved_payer_iban` | VARCHAR(34) NULL | Result of alias resolution `[V]` CAS lookup |
| `resolved_payer_bank_bic` | VARCHAR(11) NULL | |
| `amount_minor` | BIGINT | |
| `amount_modifiable` | BOOLEAN | Whether the payer may pay a different amount (partial) |
| `requested_execution_date` | DATE NULL | "Pay by" — supports *accept now, pay later* |
| `expires_at` | TIMESTAMPTZ | |
| `status` | ENUM | §9.2 |
| `decline_reason_code` | VARCHAR(20) NULL | |
| `rail_msg_id` | VARCHAR(35) NULL | `pain.013` MsgId |
| `rail_status_msg_id` | VARCHAR(35) NULL | `pain.014` MsgId |
| `fulfilling_payment_id` | FK NULL | |
| `reminder_count` | SMALLINT | |
| `last_reminder_at` | TIMESTAMPTZ NULL | |
| `mandate_id` | FK NULL | When the RtP is generated under a standing mandate |
| `bulk_batch_id` | FK NULL | Bulk RtP campaign |

### 6.11 Entity: `instrument` (cheque / pay order / demand draft / cash)

Cheque linking is explicitly required, and it is the most interesting exception path in the whole platform because it is the only place where **money can un-arrive**.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `instrument_type` | ENUM | `CHEQUE \| POST_DATED_CHEQUE \| PAY_ORDER \| DEMAND_DRAFT \| CASH \| BANKERS_CHEQUE` |
| `instrument_number` | VARCHAR(20) NULL | Cheque serial |
| `drawee_bank_bic` | VARCHAR(11) NULL | Bank that will pay |
| `drawee_branch_code` | VARCHAR(10) NULL | |
| `drawer_account_masked` | VARCHAR(40) NULL | |
| `drawer_name` | VARCHAR(200) NULL | |
| `instrument_date` | DATE NULL | Date on the face; may be future (post-dated) |
| `amount_minor` | BIGINT | Face value |
| `lodged_at_branch_id` | FK NULL | Collecting branch |
| `lodged_by_user_id` | FK NULL | Teller |
| `teller_batch_id` | FK NULL | Till/batch grouping |
| `linked_assessment_ids` | UUID[] | **The cheque-linking requirement.** One cheque may clear several assessments. |
| `linked_amounts` | JSONB | `[{assessment_id, amount_minor}]` — intended allocation, applied on clearing |
| `status` | ENUM | §9.5 |
| `clearing_cycle_id` | FK NULL | |
| `presented_on` | DATE NULL | |
| `clears_on_expected` | DATE NULL | Value date under the clearing calendar |
| `cleared_on` | DATE NULL | |
| `return_reason_code` | VARCHAR(20) NULL | `INSUFFICIENT_FUNDS`, `SIGNATURE_DIFFERS`, `STALE_DATED`, `POST_DATED`, `AMOUNT_WORDS_FIGURES_DIFFER`, `PAYMENT_STOPPED`, `ACCOUNT_CLOSED`, `MATERIAL_ALTERATION` |
| `returned_on` | DATE NULL | |
| `dishonour_charge_minor` | BIGINT | Recovered from the payer; may create a new assessment (§14.6) |
| `image_front_uri` / `image_back_uri` | TEXT NULL | Truncation/imaging |
| `provisional_credit_given` | BOOLEAN | Whether an allocation was made before clearing |

**Policy switch that must be configurable per product** (`instrument_credit_policy`):

| Policy | Behaviour | Use when |
|---|---|---|
| `ON_CLEARING` | No allocation until cleared. Assessment stays `PARTIALLY_PAID`/`ISSUED`. Safest. | Fines, service-gating products |
| `PROVISIONAL_ON_LODGEMENT` | Allocate immediately with `payment.finality='PROVISIONAL'`; reverse on return | Trusted corporate taxpayers, large tax payments where the agency accepts risk |
| `PROVISIONAL_WITH_GATE_HOLD` | Allocate provisionally but do **not** release the `service_gate_token` until final | Customs, stamp duty — pay now, but goods/instrument release waits |

### 6.12 Remaining entities (field lists abbreviated; full DDL in §23)

| Entity | Purpose | Key fields |
|---|---|---|
| `revenue_head` | Government Chart of Accounts node | `code`, `name`, `parent_id`, `fund`, `object_class`, `is_refundable_deposit`, `effective_from/to` |
| `reference_scheme` | PSID format + checksum definition | `pattern`, `length`, `checksum_algo`, `prefix_rule`, `entropy_bits`, `collision_policy` |
| `fee_schedule` / `fee_tier` | Convenience fee & MDR | `basis` (`FLAT\|PCT\|GREATER_OF\|LESSER_OF\|TIERED`), `value`, `min`, `max`, `channel`, `tax_rate_pct` |
| `limit_profile` | Velocity/amount limits | `scope` (`PRODUCT\|CHANNEL\|PAYER\|INSTITUTION\|GLOBAL`), `per_txn_max`, `daily_max`, `daily_count_max`, `monthly_max` |
| `instalment_plan` / `instalment` | Structured part-payment | `assessment_id`, `n_instalments`, `schedule[]`, `default_state`, `acceleration_rule` |
| `mandate` | Standing authority for recurring collection | `payer_id`, `product_id`, `max_amount_minor`, `frequency`, `first/final_collection_date`, `status`, `scheme_mandate_ref` |
| `ledger_account` | Chart of accounts (platform's own) | `code`, `type`, `normal_balance`, `agency_id`, `currency` |
| `journal_entry` / `journal_line` | Append-only double entry | `event_type`, `value_date`, `source_ref`, `lines[{account,dr/cr,amount}]` |
| `settlement_cycle` | A rail's netting window | `rail`, `business_date`, `cycle_no`, `cutoff_at`, `status` |
| `settlement_batch` | Per-agency position for a cycle | `agency_id`, `cycle_id`, `gross`, `fees`, `net`, `status`, `treasury_instruction_ref` |
| `scroll` / `scroll_line` | Treasury evidence file | `agency_id`, `business_date`, `format`, `line_count`, `control_total_minor`, `hash`, `signed_by` |
| `receipt` | CPR-equivalent | `receipt_no`, `payment_id`, `issued_at`, `pdf_uri`, `verify_code`, `signature`, `template_version` |
| `refund` | Money out | `payment_id`, `reason_code`, `amount_minor`, `beneficiary`, `approval_id`, `status`, `outbound_payment_id` |
| `reversal` | Undo of a payment | `payment_id`, `initiator` (`TELLER\|SWITCH\|RAIL\|OPS`), `window_ok`, `approval_id` |
| `dispute` | Payer-raised claim / chargeback | `payment_id`, `type`, `reason_code`, `evidence[]`, `sla_due_at`, `outcome` |
| `recon_run` / `recon_source_record` / `recon_match` / `recon_break` | §12 | |
| `adjustment` | Maker-checker financial correction | `type`, `amount_minor`, `narrative`, `break_id`, `approval_id`, `journal_entry_id` |
| `approval` | Generic maker-checker envelope | `subject_type`, `subject_id`, `maker_user_id`, `checker_user_id`, `state`, `decided_at`, `comment` |
| `audit_log` | Immutable trail | `actor`, `action`, `entity`, `before`, `after`, `ip`, `correlation_id`, `hash_prev` (hash-chained) |
| `webhook_subscription` / `webhook_delivery` | Outbound events | `url`, `events[]`, `secret`, `attempt`, `next_retry_at`, `signature` |
| `outbox_event` | Transactional outbox | `aggregate`, `event_type`, `payload`, `published_at` |
| `institution` | Bank/EMI/PSP/aggregator | `bic`, `name`, `type`, `raast_participant_type` (`DIRECT\|SPECIAL\|INDIRECT`) `[V]`, `settlement_member_bic` |
| `business_calendar` | Holidays and cut-offs | `jurisdiction`, `date`, `is_business_day`, `cutoffs{}` |

---

## 7. Reference & Identifier Design

The reference is the product. If the reference is well designed, reconciliation is nearly free; if it is badly designed, no amount of matching cleverness rescues it.

### 7.1 Design principles

1. **Self-validating.** A reference must be checkable offline, before any database lookup, so that a typo is rejected at the ATM keypad rather than becoming an unapplied receipt.
2. **Non-guessable where it exposes data.** A sequential PSID lets anyone enumerate other people's tax demands. Include entropy.
3. **Fixed length per scheme, and distinguishable between schemes.** A teller should be able to tell a token-tax PSID from a customs PSID by looking at it.
4. **Keypad-safe.** Digits only for anything a payer may type on an ATM or IVR. No letters, no ambiguity between `0`/`O` and `1`/`l`/`I`.
5. **Never encode secrets or PII.** No CNIC digits inside the PSID.
6. **Stable for the life of the obligation.** Amending an amount must not change the PSID; the payer may already have written it down.

### 7.2 PSID scheme (platform default)

**Format: 17 digits, numeric only.**

```
 A A   B B B B   C C C C C C C C C C   D
 └┬┘   └──┬───┘  └───────┬──────────┘  │
  │       │              │             └── 1 check digit (Damm, base-10)
  │       │              └──────────────── 10-digit body: 6 sequence + 4 random
  │       └─────────────────────────────── 4-digit product code
  └─────────────────────────────────────── 2-digit agency scheme prefix

Real example from the demo data:

  41 0113 0000019012 3   →  41011300000190123
  │  │                     PSCA traffic e-challan, moving violation
  │  └── product 0113
  └───── agency prefix 41 = Punjab Safe Cities Authority

Grouped for humans:  41-0113-0000019012-3
```

- **Agency prefix (2)**: routes resolution without a database lookup. `12` = FBR, `21` = PRA, `31` = Excise Punjab, etc.
- **Product code (4)**: identifies the collection product, so the channel can display the right label before resolving.
- **Body (10)**: 6 digits of a per-product monotonic sequence + 4 digits of cryptographically-random padding. The random component defeats enumeration; the sequence keeps the index dense and makes operational debugging humane.
- **Check digit (1)**: **Damm algorithm**, not Luhn. Rationale: Damm detects all single-digit errors *and all adjacent transpositions*, which Luhn does not (Luhn misses the `09`↔`90` transposition). Transposition is the dominant human keying error, so this choice measurably reduces unapplied receipts.

> **Implementing agent:** implement `damm_checksum(digits) -> digit` and `damm_validate(psid) -> bool` with the standard 10×10 anti-symmetric quasigroup matrix, and unit-test that (a) every single-digit substitution is caught and (b) every adjacent transposition is caught, across 10,000 random PSIDs. This test is a strong demo talking point — run it live.

### 7.3 Alternative and legacy reference schemes

Real deployments must accept references the platform did not mint. `reference_scheme` therefore supports:

| `checksum_algo` | Use |
|---|---|
| `DAMM` | Platform default |
| `LUHN` | Card-like and many legacy government references |
| `MOD_97_10` | ISO 7064, as used by IBAN and ISO 11649 |
| `MOD_11` | Common in older utility consumer numbers |
| `NONE` | Legacy schemes with no protection — **must** then be paired with mandatory amount-and-name verification at resolution time to compensate |

`collision_policy` handles the awkward real-world case where two agencies' legacy schemes produce the same digits: `PREFIX_DISAMBIGUATE` (require the payer to pick the agency), `AMOUNT_DISAMBIGUATE`, or `REJECT_AMBIGUOUS`.

### 7.4 ISO 11649 RF Creditor Reference — for rails with structured remittance

When the rail supports structured remittance, emit the PSID wrapped as an ISO 11649 creditor reference: `RF` + 2 check digits (ISO 7064 MOD-97-10) + up to 21 alphanumeric characters.

```
PSID 41011300000190123  →  RF37 4101 1300 0001 9012 3      (21 chars, verified)
PSID 31010900000181526  →  RF18 3101 0900 0001 8152 6
PSID 12010400001661551  →  RF40 1201 0400 0016 6155 1
```

Two independent check layers (RF's MOD-97-10 over the whole string, plus Damm inside the PSID) means a corrupted reference is essentially never silently misapplied. This is the single highest-leverage change available for pushing auto-match rates above 99.5%.

Validation, for the implementing agent: strip `RF` and the two check digits, append `2715` (the numeric encoding of `R`,`F`) and the check digits, then assert `mod 97 == 1`. Both examples above satisfy this; they are generated and verified by `scripts/generate_demo_data.py`.

### 7.5 Resolution keys and the metadata index

Reference resolution (§8.2, C3) must accept **any** of these and return zero, one, or many payables:

| Key type | Example | Cardinality of result | Privacy control |
|---|---|---|---|
| `PSID` | `41011300000190123` | 0..1 | Full detail |
| `CRN` (consumer number) | `PB-PT-0041882` | 0..n open assessments | Full detail |
| `RF_REFERENCE` | `RF3741011300000190123` | 0..1 | Full detail |
| `VEHICLE_REG` | `LEA-17-1000` | 0..n (token tax + challans) | **Masked payer name**, amounts shown |
| `CNIC` | `35202-*******-1` | 0..n across agencies | **Requires OTP step-up** (§20.6) |
| `NTN` / `STRN` | `1234567-8` | 0..n | Requires authenticated corporate session |
| `CASE_NO` | `CP-1123/2026` | 0..n | Masked |
| `APPLICATION_NO` | `PP-2026-8891245` | 0..1 | Masked |
| `QR_PAYLOAD` | EMVCo string | 0..1 | Full detail |
| `RAAST_ID` | `+923001234567` | 0..n | Requires step-up |

Implement as a `resolution_index` table (`agency_id`, `key_type`, `key_value_normalised`, `assessment_id`, `expires_at`) maintained by trigger or outbox on assessment write. **Do not resolve by scanning `assessment.metadata` JSONB at request time** — the resolution API has a 300 ms p99 budget (§19.2) and the index is what makes that achievable. Normalise aggressively on write: uppercase, strip spaces and hyphens, and store both raw and normalised forms of vehicle registrations (`LEA-17-1000` → `LEA171234`).

### 7.6 Other identifier formats

| Identifier | Format | Notes |
|---|---|---|
| `payment_reference` | `P` + 2-digit year + 5-char Crockford base32 sequence (8 chars) | e.g. `P260002H` — short enough to read over the phone. Crockford base32 excludes `I`, `L`, `O` and `U`, so there is nothing to mishear. **Production SHOULD append a Damm check digit** (9 chars); the demo generator omits it because these references are system-to-system, never keyed by a payer. |
| `receipt_no` (CPR) | `{AGENCY}{YYYYMMDD}{9-digit seq}` | e.g. `FBR20260730000012345`. Human-legible, sortable, agency-scoped. |
| `intent_reference` | `I` + the payment reference + a sequence, or `I` + ULID in production | Sortable by creation time; never shown to payers |
| `rtp_reference` | `R` + 2-digit year + 4-digit sequence in the demo (`R260001`); `R` + ULID in production | Quoted as `EndToEndId` on the fulfilling credit, which is how an RtP is matched to its payment (§8.3 step 9) |
| `verify_code` (on receipt) | 8-char base32, Damm-protected | For third-party verification at `/verify/{code}` |
| `correlation_id` | UUIDv7 | Set at the edge, propagated to every log line, event, and downstream call |
| `scroll_id` | `{AGENCY}-SCR-{YYYYMMDD}-{NN}` | `NN` = intraday sequence |

---

## 8. Collection Journeys (the acceptance surface)

Fourteen journeys. Each is specified as: trigger, precondition, step sequence, money movement, ledger events, failure modes, and demo data anchor. **These are the demo script.**

### 8.1 The channel abstraction

Every journey reduces to the same five-phase pipeline. If a new channel cannot be expressed in it, the abstraction is wrong.

```
 1. RESOLVE      reference/attribute → payable(s)          [read-only, idempotent, fast]
 2. QUOTE        payable(s) + amount + channel → intent    [computes fees, limits, expiry]
 3. AUTHORISE    payer consent captured                    [channel-specific: PIN, OTP, biometric, teller, signature]
 4. CAPTURE      money moves on a rail / instrument lodged [the only phase that touches money]
 5. APPLY        allocate → post ledger → receipt → notify [idempotent, replayable]
```

Channel adapters implement only phases 3 and 4, and declare capabilities:

```yaml
channel_capability:
  code: QR_DYNAMIC
  supports_partial: true
  supports_multi_payable: false
  authorisation_mode: PAYER_DEVICE_PIN
  capture_mode: PUSH            # PUSH | PULL | INSTRUMENT | CASH
  rail: RAAST
  finality: FINAL
  confirmation_latency_p99_ms: 3000
  reversal_window_seconds: 0    # rail-final, no channel reversal
  requires_online_resolution: true
```

### 8.2 Journey 1 — Reference resolution (the front door of every other journey)

**Trigger:** payer enters a reference, scans a QR, or a bank channel calls the biller API.

| # | Step | Detail |
|---|---|---|
| 1 | Channel calls `POST /v1/resolve` with `{key_type, key_value, channel, institution_id}` | mTLS + OAuth2 client credentials |
| 2 | Offline validation | Length, charset, checksum. Fail fast with `INVALID_REFERENCE_CHECKSUM` — **no DB hit**. |
| 3 | Rate/abuse check | Per-institution and per-key-value velocity; enumeration detection (§20.6) |
| 4 | Index lookup | `resolution_index` → candidate assessments |
| 5 | Recompute derived amounts | Surcharge accrual to *today*, early-payment discount, rounding (§15.4). **Never return a stale amount.** |
| 6 | Eligibility filter | Channel allowed? Not expired? Not already settled? Agency active? |
| 7 | Privacy shaping | Mask per §7.5 by key type and authentication level |
| 8 | Respond | `payables[]` with `psid`, `label`, `payable_amount_minor`, `min_payable_minor`, `due_date`, `expires_at`, `partial_allowed`, `resolution_token` |

**`resolution_token`** is a short-lived (5 min) signed JWT binding the resolved amount to the payable set. The subsequent quote/capture call MUST present it. This closes a real attack: resolve at PKR 1,000, wait for a surcharge to accrue, then pay the stale PKR 1,000 and claim discharge. It also gives you a free audit record of exactly what the payer was shown.

**Failure modes and payer-facing outcomes:**

| Outcome | Code | Payer message |
|---|---|---|
| Checksum fails | `INVALID_REFERENCE_CHECKSUM` | "That number doesn't look right — please check and re-enter." |
| Not found | `REFERENCE_NOT_FOUND` | "We couldn't find a bill with this number." |
| Found but expired | `PAYABLE_EXPIRED` | "This bill expired on {date}. Generate a new one at {agency portal}." |
| Already settled | `ALREADY_SETTLED` | "Already paid on {date}. Receipt {no}." **Include the receipt — this single behaviour prevents a large share of duplicate payments.** |
| Multiple found | `MULTIPLE_PAYABLES` (HTTP 200 with list) | "We found 3 unpaid items for LEA-17-1000." |
| Channel not allowed | `CHANNEL_NOT_ELIGIBLE` | "This bill can't be paid at an ATM. Please use internet banking." |
| Agency offline | `AGENCY_UNAVAILABLE` | "{Agency} systems are temporarily unavailable." |
| Step-up needed | `AUTHENTICATION_REQUIRED` | Trigger OTP |

**Demo anchor:** resolve `VEHICLE_REG = LEA-17-1000` → **3 open payables plus 1 already settled**:

| PSID | Product | Amount | Note |
|---|---|---|---|
| `31010900000181526` | Motor Vehicle Token Tax 2026-27 | PKR 10,000.00 | `OVERDUE` |
| `41011300000190123` | Traffic e-Challan — over-speeding | PKR 3,750.00 | `ISSUED`, PKR 1,250 early-payment discount still live |
| `41011400000286611` | Traffic e-Challan — parking | PKR 3,000.00 | `OVERDUE` |
| `41011400001606295` | Traffic e-Challan — parking (Jan) | — | `ALREADY_SETTLED`, receipt returned |

This is the strongest 15 seconds in the demo: the payer knows only a number plate, and the platform hands back a live, priced, discount-aware, duplicate-proof picture of everything the citizen owes across two different agencies.

### 8.3 Journey 2 — Request to Pay (RtP)

**The flagship journey.** `[V]` Raast delivered Request to Pay as an overlay service alongside P2P and CAS smart addressing, so an alias-addressed RtP is the right design target. `[A]` Exact message versions, expiry windows, and decline codes must be confirmed with SBP.

**Trigger:** agency (or the platform on a schedule) wants to ask a payer to settle an assessment.

| # | Step | Detail | Message |
|---|---|---|---|
| 1 | Agency calls `POST /v1/requests-to-pay` with `{assessment_ids[], payer_alias, amount_modifiable, expires_at, requested_execution_date}` | Idempotent on `Idempotency-Key` | |
| 2 | Validate | Assessments open, same agency, same currency, total > 0, alias format valid | |
| 3 | Resolve alias | CAS lookup → payer IBAN + bank BIC. `[V]` aliases may be expired → `ALIAS_EXPIRED` | |
| 4 | Create `request_to_pay` | Status `CREATED` | |
| 5 | Emit to rail | Payee's PSP → scheme → payer's PSP | `pain.013` |
| 6 | Rail/PSP acknowledges receipt | Status → `DELIVERED` | `pain.014` (`RCVD`) |
| 7 | Payer's bank presents the request in-app | Shows agency name, purpose, amount, due date, and **the assessment description** — carry rich remittance data, not just an amount | |
| 8a | Payer **accepts now** | Status → `ACCEPTED`; payer's bank initiates a credit transfer | `pain.014` (`ACCP`) then `pacs.008` |
| 8b | Payer **accepts, pays later** | Status → `ACCEPTED_FUTURE_DATED`; scheduled for `requested_execution_date` | `pain.014` (`ACWC`) |
| 8c | Payer **declines** | Status → `DECLINED` with reason. Notify agency. **Do not auto-retry a decline** — retry an expiry, never a refusal. | `pain.014` (`RJCT`) |
| 8d | Payer **modifies amount** (if `amount_modifiable`) | Partial acceptance; status → `ACCEPTED_PARTIAL` | `pain.014` + `pacs.008` for less |
| 8e | No response by `expires_at` | Status → `EXPIRED`; eligible for one reminder cycle | |
| 9 | Inbound credit arrives | Match on `EndToEndId` = `rtp_reference` → link `fulfilling_payment_id`, status → `FULFILLED` | `pacs.008` |
| 10 | Apply, receipt, notify | Standard phase 5 | |
| 11 | Agency cancels an outstanding RtP (assessment withdrawn) | Status → `CANCELLED`; send cancellation | `camt.056`-equivalent / `pain.014` |

**Critical design details that separate a real RtP implementation from a toy:**

- **An RtP is a request, not a receivable.** Creating one changes no balance and posts no journal entry. Only the resulting credit does. Reviewers will probe this; get it right.
- **Expiry is a state, not a cron artefact.** Compute `EXPIRED` from `expires_at` on read as well as by scheduler, so status is never wrong just because a job is late.
- **Reminders are configurable and capped.** `reminder_policy: {max: 2, interval_days: 7, quiet_hours: "21:00-08:00 Asia/Karachi"}`. Government RtPs that spam citizens create political problems, so cap them and log every send.
- **Late fulfilment after expiry.** A credit may arrive against an expired RtP (the payer approved just before expiry; the rail was slow). **Accept the money.** Match it, apply it, and mark the RtP `FULFILLED_LATE`. Never reject funds for a paperwork reason — that creates an unapplied receipt and an angry citizen.
- **Duplicate fulfilment.** Payer accepts, the response times out, the payer's app retries, two credits arrive. Second credit → duplicate detection (§14.5) → auto-refund per `overpay_treatment`. Demo this.
- **Bulk RtP campaigns.** `POST /v1/requests-to-pay/bulk` with a file of 5,000 token-tax reminders. Needs per-row outcome reporting, throttling, and a kill switch. Model as `bulk_batch` with `row_status[]`.

**Demo anchor:** `R260001` to alias `+923011063352` for motor vehicle token tax of PKR 11,500.00 → accepted → fulfilling credit arrives on the `RTP` channel as payment `P260002H`, whose `EndToEndId` **is** `R260001` → allocated → receipt issued. The seed data also carries `DELIVERED`, `PRESENTED`, `DECLINED`, `EXPIRED`, `ACCEPTED_FUTURE_DATED`, `CANCELLED` and `UNDELIVERABLE` (lapsed alias) rows — eight distinct lifecycle states in all.

### 8.4 Journey 3 — Authorised Push Payment (APP) from a bank app

**Trigger:** payer opens their bank app, chooses "Pay Government Bill", enters a PSID.

| # | Step | Money/ledger |
|---|---|---|
| 1 | Bank calls `POST /v1/resolve` → payable + `resolution_token` | — |
| 2 | Payer confirms amount; bank calls `POST /v1/payment-intents` with the token | Intent `CREATED`; fees computed |
| 3 | Payer authorises in-app (PIN/biometric) | — |
| 4 | Bank debits payer, sends credit transfer to the agency's or platform's account with `EndToEndId = intent_reference` | Rail moves money |
| 5 | Platform receives the credit — via `camt.054` notification, a rail webhook, or the bank's `POST /v1/payments` confirmation | `payment` `CONFIRMED`, `finality=FINAL` |
| 6 | Match intent → allocate → post journals → issue receipt → webhook to agency | §10.6 template `TPL-COLLECT` |
| 7 | Bank shows success with `receipt_no` | — |

**Failure modes — specify each, because this is where money gets lost in real systems:**

| Scenario | Correct behaviour |
|---|---|
| Bank debits payer, platform never receives the credit | Intent stays `AUTHORISED`; reconciliation finds an unmatched credit in the bank statement next cycle; auto-match on `EndToEndId`; receipt issued late. **Payer must not be asked to pay again.** |
| Platform confirms, response to the bank times out | Bank retries with the same `Idempotency-Key` → same response, no second payment. Bank may also call `GET /v1/payments?intent_reference=...`. |
| Credit arrives after the intent expired | Accept and apply. Expiry governs the *quote*, not the money. If the amount has since changed (surcharge accrued), apply what arrived and leave the shortfall as a balance — do **not** reject. |
| Credit amount ≠ intent amount | Apply the actual amount. Under-payment within tolerance → settled; beyond tolerance → partial. Over-payment → per `overpay_treatment`. |
| Credit arrives with no intent (payer pushed funds manually, PSID in narrative) | Parse the narrative (§11.6). If a PSID is found and unambiguous, apply. Otherwise → unapplied receipt. |

### 8.5 Journey 4 — QR-initiated payment

Two sub-flows. `[V]` Raast supports QR codes for the merchant/business use case.

**4a. Dynamic merchant-presented QR** (agency counter, e-challan slip, tax notice)

The QR encodes a specific payable and amount. Build to **EMVCo Merchant-Presented Mode** tag structure:

| Tag | Content | Value in a P2G context |
|---|---|---|
| `00` | Payload format indicator | `01` |
| `01` | Point of initiation | `11` static / `12` dynamic |
| `26`–`51` | Merchant account information template | Domestic scheme: agency/biller ID + platform ID |
| `52` | Merchant category code | Government/civil-service MCC (e.g. `9311` tax payments) `[A]` confirm per scheme |
| `53` | Transaction currency | `586` (PKR) |
| `54` | Transaction amount | Payable amount, absent for open-amount QR |
| `55`–`57` | Tip/fee indicators | Convenience fee, if payer-borne |
| `58` | Country code | `PK` |
| `59` | Merchant name | Agency legal name (truncated to 25 chars) |
| `60` | Merchant city | |
| `62` | Additional data field template | `01` **Bill Number = PSID** · `05` Reference Label = `payment_reference` · `07` Terminal label · `08` Purpose of transaction |
| `63` | **CRC-16/CCITT-FALSE** | Computed over the whole payload including `6304` |

Real payload from `demo-data/qr-payloads.json` (sample `dynamic_with_amount`, 184 chars,
CRC verified) — a PSCA traffic e-challan for PKR 3,750.00:

```
00020101021226340008PK.RAAST0112NEXUSCOLLECT0202415204931153035865407
3750.005802PK5923PUNJAB SAFE CITIES AUTH6006LAHORE625301174101130000
01901230511CHL-07791230713AGENCY-CTR-016304866B
```

Decoded: `00`=`01` · `01`=`12` (dynamic) · `26`=domestic scheme template
(`PK.RAAST`/`NEXUSCOLLECT`) · `52`=`9311` · `53`=`586` · `54`=`3750.00` ·
`58`=`PK` · `59`=`PUNJAB SAFE CITIES AUTH` · `60`=`LAHORE` ·
`62`→`01`=**PSID `41011300000190123`**, `05`=`CHL-0779123`, `07`=`AGENCY-CTR-01` ·
`63`=`866B`.

(Line breaks above are for legibility only; the payload is one unbroken string.)

> **Implementing agent:** implement `emv_tlv_encode`, `emv_tlv_decode`, and `crc16_ccitt_false`. Round-trip every QR in `demo-data/qr-payloads.json` and assert the CRC. Include one QR with a deliberately wrong CRC and assert rejection with `QR_CRC_INVALID`.

Flow: payer scans → bank app decodes → extracts PSID from tag `62`/`01` → `POST /v1/resolve` (`key_type=QR_PAYLOAD`) → **the QR amount is a hint; the resolved amount is authoritative** → if they differ, show the resolved amount and flag `AMOUNT_UPDATED` → then exactly Journey 3 from step 2. The QR is a *reference-transport mechanism*, not a payment mechanism. Say this out loud in the demo; it is the insight that makes the architecture obvious.

**4b. Static QR at an agency counter** (open amount, e.g. a court fee window)

QR encodes the agency/product but no amount and no PSID. Payer scans, enters the amount, and — critically — must supply a reference the agency can use, or the payment becomes an unapplied receipt by construction. Mitigations, in order of preference: require a case/application number in the app before payment; or have the teller generate a PSID and a dynamic QR on the spot (preferred; make this the default and the static QR an explicit fallback); or accept it as unapplied and reconcile against the counter's manual register.

**Demo anchor:** `qr-payloads.json` holds four QRs — dynamic with amount, dynamic open-amount, static counter QR, and one CRC-corrupted.

### 8.6 Journey 5 — Biller engine / aggregator bill payment (1BILL-style)

The four-message contract (§4.2), exposed by the platform as the **biller** to a switch. This is the journey that lights up every ATM and mobile app in the country from one integration.

| Message | Platform behaviour | Timing budget |
|---|---|---|
| **Bill Inquiry** | Validate reference offline → resolve → return payable amount, due date, payer name (masked per policy), min/max payable, partial-allowed flag, and a **response reference the switch must echo on payment** | p99 ≤ 300 ms |
| **Bill Payment** | Idempotent on `(acquirer_id, stan, rrn, txn_date)`. Create `payment` `CONFIRMED`, allocate, post ledger, return `receipt_no` in a field the switch can print on the ATM slip | p99 ≤ 800 ms |
| **Bill Payment Reversal** | Reverse allocations, contra journal, void receipt, restore assessment balance. **Must handle reversal-without-original** (§4.2) | p99 ≤ 500 ms |
| **Bill Payment Advice** | Late confirmation of a payment the platform holds as `UNCERTAIN` → resolve to `CONFIRMED` or `FAILED` | async |

Hard requirements:

- **Never return a soft failure to a switch.** Either the payment is recorded and you return success, or nothing is recorded and you return a definite failure code. `UNCERTAIN` is a legitimate *internal* state but must never be the switch response — the switch cannot act on it and will reverse, or worse, retry.
- **Response code mapping table** is mandatory config, not code: `platform_error_code → switch_response_code` per aggregator. `[A]` Obtain 1LINK's code list from the integration specification.
- **Echo discipline.** Every field the switch sends and expects echoed must be echoed byte-identically, including trailing spaces. Switch certification fails on this more often than on logic.
- **Timeout stance.** If the platform cannot answer a Bill Payment within the switch's timeout, the switch will reverse. Therefore: write the payment inside a single database transaction that commits before the response is composed, so a late reversal always finds an original to reverse.

### 8.7 Journey 6 — Over-the-counter cash at a bank branch or agent

| # | Step | Control |
|---|---|---|
| 1 | Payer presents a printed challan / quotes a PSID | |
| 2 | Teller resolves; system displays the payable and payer name | Teller confirms identity per product policy |
| 3 | Teller accepts cash; enters denominations for till control | Cash counted twice for amounts above a threshold |
| 4 | `POST /v1/payments` with `channel=OTC_CASH`, `instrument_type=CASH`, `teller_batch_id`, `branch_id` | `payment` `CONFIRMED`, `rail=CASH`, `finality=FINAL` |
| 5 | Allocate, post ledger (Dr Cash-in-Till, Cr Agency Payable), print receipt | Receipt has `verify_code` QR |
| 6 | Teller error within the session | `POST /v1/payments/{id}/reverse` — allowed only same till, same business date, before till close, **and only with supervisor approval** |
| 7 | Till close | Physical cash vs `SUM(payments)`; produce a **till reconciliation** with over/short. Over/short posts to a dedicated suspense account and requires a break record. |
| 8 | Branch scroll | Branch-wise, head-wise scroll joins the daily agency scroll (§13.5) |

Agent/branchless banking is identical with `channel=AGENT`, plus agent float management: the agent's float account is debited as the payer's cash is received, and the agent settles with the institution separately. Model `agent_float_account` and post to it; do not pretend an agent is a branch.

### 8.8 Journey 7 — Cheque, pay order, or demand draft with instrument linking

The explicitly requested journey, and the richest one.

| # | Step | State | Ledger |
|---|---|---|---|
| 1 | Payer presents a cheque for PKR 2,500,000 against three tax challans | — | — |
| 2 | Teller creates `instrument` with `linked_assessment_ids` and `linked_amounts` — **the linking step** | `LODGED` | Dr Cheques-in-Hand / Cr Cheque-Suspense (memo, no agency credit yet) |
| 3 | Validation | Face amount = Σ linked amounts (or handle the difference explicitly: excess → unapplied, shortfall → reject or partial per product policy). Instrument date not stale (>6 months) and not post-dated unless the product allows it. Drawee bank is a valid participant. | |
| 4 | Per `instrument_credit_policy` (§6.11): `ON_CLEARING` → no allocation; `PROVISIONAL_ON_LODGEMENT` → allocate now with `finality=PROVISIONAL`; `PROVISIONAL_WITH_GATE_HOLD` → allocate but withhold `service_gate_token` | | Provisional variants: Dr Cheque-Suspense / Cr Agency Payable (Provisional) |
| 5 | Present into clearing; assign `clearing_cycle_id` and `clears_on_expected` from the clearing calendar | `IN_CLEARING` | |
| 6a | **Cleared** | `CLEARED` | Dr Cheques-in-Hand / Cr Cheque-Suspense reversed; Dr Bank / Cr Agency Payable (Confirmed). Provisional allocations become `FINAL`; gate token released; receipt issued (or re-issued as final) |
| 6b | **Returned** | `RETURNED` | Reverse every allocation (`reversal_reason=CHEQUE_RETURNED`), contra all journals, void the receipt, restore assessment balances, revert `SETTLED` → `PARTIALLY_PAID`/`ISSUED`, re-open the service gate, notify payer and agency, **and raise a dishonour-charge assessment if the product configures one** (§14.6) |
| 7 | Post-dated cheque | `HELD_POST_DATED` until `instrument_date`, then auto-present | |
| 8 | Stop payment before presentment | `STOPPED` | Reverse any provisional allocation |

**Multi-cheque, multi-assessment linking.** The general case is many-to-many: three cheques covering four challans. Model it as `instrument_link(instrument_id, assessment_id, amount_minor)` and require `Σ links per instrument ≤ instrument.amount_minor`. When one of three cheques bounces, reverse **only that cheque's** allocations — which works correctly only because allocations are per-instrument-derived-payment. This is a direct payoff of the §6.4 modelling decision, and worth showing explicitly in the demo.

**Demo anchor:** `instruments.csv` contains 6 instruments spanning 4 statuses:

| ID | Type | Amount (PKR) | Links | Status |
|---|---|---|---|---|
| `IN-0001` | Cheque `004821` | 1,214,195.00 | **3 income-tax challans** | `CLEARED` |
| `IN-0002` | Pay order `PO-778120` | 632,000.00 | 1 customs GD (gate-hold policy) | `CLEARED` |
| `IN-0003` | Demand draft `DD-991204` | 500,000.00 | 1 tender deposit | `CLEARED` |
| `IN-0004` | Cheque `004822` | 644,112.00 | **3 sales-tax challans** | **`RETURNED` — insufficient funds after provisional credit** |
| `IN-0005` | Post-dated cheque `004823` | 12,400.00 | 1 professional tax | `HELD_POST_DATED` |
| `IN-0006` | Cheque `004824` | 85,900.00 | 1 individual income tax | `IN_CLEARING` |

`IN-0004` is the one to demonstrate: it drives the complete reversal chain and an automatically raised dishonour-charge assessment.

### 8.9 Journey 8 — Card and wallet payment

| Aspect | Requirement |
|---|---|
| Rails | PayPak domestic scheme, international schemes, wallet (EMI) balance |
| PCI-DSS scope | **The platform MUST NOT touch a PAN.** Use a hosted field / redirect / SDK so card data never enters platform systems. Store only a network token or gateway token, plus BIN6 and last4. This keeps the platform out of PCI-DSS scope, which is worth explicitly stating in the design because it is a procurement question that gets asked every time. |
| Auth model | Two-step: authorise, then capture. For service-gating products, capture immediately; for open-amount products, authorise then capture the final amount. |
| MDR | Card MDR is materially higher than instant-rail fees. `fee_bearer` and `fee_schedule` per channel matter commercially. Show the payer the fee **before** authorisation, always. |
| Chargeback | Cards introduce the only true chargeback risk in the platform: a payer can dispute a tax payment weeks later. Model `dispute` with scheme reason codes, representment evidence (the receipt, the resolution audit, the assessment), and a liability decision. **Government revenue clawed back by a chargeback is an accounting event the agency must see** — do not hide it inside the payment record. |
| 3-D Secure | Mandatory for card-not-present government collection `[A]` confirm current SBP requirements |

### 8.10 Journey 9 — Bulk corporate file payment

**Trigger:** a withholding agent must pay 850 withholding-tax challans in one go.

| # | Step | Detail |
|---|---|---|
| 1 | Corporate uploads a file (CSV/ISO 20022 `pain.001` with multiple transactions, or an agreed fixed-width format) | `POST /v1/bulk-payments` multipart |
| 2 | **Validate the whole file before accepting any of it.** Row-level: PSID checksum, exists, open, amount, currency. File-level: control record with row count and total; duplicate-file detection by content hash. | Return per-row outcomes; reject the file if the control total mismatches |
| 3 | Corporate reviews the validation report and confirms | `POST /v1/bulk-payments/{id}/confirm` |
| 4 | Corporate makes **one** RTGS/Raast credit for the file total, quoting the `bulk_reference` | One `payment` for the whole file |
| 5 | On credit receipt, allocate to all 850 assessments per the file's explicit allocations | 850 `payment_allocation` rows against **one** `payment` |
| 6 | Issue 850 receipts plus one consolidated advice | |
| 7 | If the credit ≠ the file total | Configurable: `REJECT_ALL` (safest, default), `APPLY_PRO_RATA`, or `APPLY_IN_ORDER_UNTIL_EXHAUSTED` with the remainder unapplied |

`[A]` Where the rail's remittance field cannot carry 850 allocations, the file *is* the remittance advice — this is exactly the ISO 20022 `remt.001` standalone remittance advice pattern (§4.5). Model the linkage explicitly: `payment.bulk_batch_id`.

**Demo anchor:** one bulk batch of 12 challans paid by a single PKR credit, with **one row deliberately referencing an already-settled PSID** to exercise the pre-validation rejection path.

### 8.11 Journey 10 — Direct debit / mandate-based recurring collection

For annual token tax, quarterly advance tax, monthly property tax.

| # | Step |
|---|---|
| 1 | Payer establishes a `mandate`: product, max amount, frequency, first and final collection date, and a scheme mandate reference |
| 2 | Mandate authorised by the payer at their bank (or via an e-mandate flow) |
| 3 | On each due date the platform generates an assessment (or picks up the agency's) and initiates collection under the mandate |
| 4 | **Pre-notification is mandatory:** notify the payer N days before debiting (`[A]` typically 3–10 days; confirm the scheme rule). A government direct debit that surprises a citizen is a complaint and a headline. |
| 5 | Collection succeeds → normal apply path |
| 6 | Collection fails (insufficient funds) → retry policy `{max: 2, interval_days: 3}`, then mandate → `SUSPENDED`, notify payer and agency, fall back to RtP |
| 7 | Payer revokes the mandate → `CANCELLED`; no further collection; any in-flight collection completes or is recalled per scheme rules |

**Design note.** A mandate is best implemented as *an automated RtP with pre-granted consent*. Reuse the RtP machinery and set `authorisation_mode = MANDATE`. This avoids a second, parallel collection engine — and a parallel engine is exactly how platforms end up with two different reconciliation behaviours.

### 8.12 Journey 11 — Agency portal / API-embedded checkout

Agency's own web portal computes a liability and hands the payer to the platform.

1. Agency backend calls `POST /v1/assessments` → gets a PSID.
2. Agency calls `POST /v1/checkout-sessions` → gets a hosted checkout URL and a `session_token`.
3. Payer is redirected; the platform presents every eligible channel (QR, APP handoff, card, wallet, RtP-to-my-phone, "print challan and pay at a branch").
4. On completion the platform redirects back with a signed result and **independently** fires a server-to-server webhook. **The agency must trust only the webhook** (or a server-side `GET`), never the browser redirect — the redirect is attacker-controlled. Say this in the integration guide; it is the most common integration security failure in payments.
5. `service_gate_token` released to the agency so it can deliver the service.

### 8.13 Journey 12 — Print-and-pay (offline challan)

Still the highest-volume government channel in most markets, and frequently forgotten in modern designs.

1. Payer generates a challan PDF from the agency portal or the platform.
2. The PDF carries: PSID in large digits, grouped for legibility; a barcode (Code 128) and an EMVCo QR of the same PSID; the amount; a validity date; head-wise breakdown; and bank-copy / payer-copy / agency-copy sections.
3. The payer takes it to any branch. Teller scans the barcode → Journey 6.
4. **The printed amount will go stale** if a surcharge accrues. Print `Amount valid until {date}; after that pay {escalated amount}` and have the teller always use the resolved live amount. Print both, and make the teller's screen authoritative.

### 8.14 Journey 13 — Third-party payment

Someone paying another party's obligation: a lawyer paying court fees, a clearing agent paying customs duty, a son paying his father's property tax. This is extremely common in P2G and structurally awkward, so specify it rather than discovering it in UAT.

Requirements:

- The obligation stays attached to the **original payer** (`assessment.payer_id` unchanged). Tax credit accrues to the taxpayer, not the person who paid.
- The payment records the **actual remitter** in `payment_intent.third_party_payer` and on the payment: name, masked ID, relationship, and their contact for the receipt copy.
- Privacy: the third party sees only what §7.5 permits for the key they used — typically amount and a masked name, never the full assessment history.
- The receipt names both: "Received from {remitter} on behalf of {taxpayer}".
- Refunds go back to the **remitter's** account, not the taxpayer's. Getting this backwards creates both a fraud vector and a legal problem, so make `refund.beneficiary` default to the original debit account and require an approved override to change it.
- AML: a clearing agent paying thousands of duties is a legitimate high-volume pattern; a random individual paying 40 strangers' bills is not. Velocity monitoring must be per-remitter, not only per-taxpayer.

### 8.15 Journey 14 — Unsolicited credit and reference-less money

Money arrives that nobody asked for in a way the platform understands: an RTGS credit with "TAX PAYMENT AHMED" in the narrative and no PSID.

1. Credit appears in `camt.053`/`camt.054` with no matching intent, e2e id, or parseable reference.
2. Create `payment` with `status=CONFIRMED`, `agency_id=NULL`, `unapplied_amount_minor = gross`.
3. Post: **Dr Bank / Cr Unapplied Receipts (liability)** — the money is real, so it must be on the balance sheet, and it is not yet revenue.
4. Raise a `recon_break` of type `UNMATCHED_CREDIT` with the raw narrative attached, assigned to the recon queue, SLA-tracked, and aged.
5. Investigation tools: fuzzy search of the narrative against payer names, NTNs, and open assessments; amount-and-date proximity search; the debit account's history of previous payments (**the strongest signal in practice — most reference-less payers have paid correctly before**).
6. Analyst proposes an allocation → approver approves → allocate with `allocation_basis=MANUAL` and an `approval_id`. **Dr Unapplied Receipts / Cr Agency Payable.**
7. If still unresolved after N days (`[A]` typically 30–90; confirm the operator's client-money policy), escalate per policy: return to remitter, or transfer to a long-term unclaimed-funds account. **Never write it to income.**

**Demo anchor:** two unapplied receipts in the seed data — one resolvable by narrative fuzzy match, one genuinely unresolvable and aged 14 days.
---

## 9. State Machines

Implement each as an explicit, table-driven transition guard. **No status field may be assigned by direct `UPDATE`;** every change goes through `transition(entity, from, to, event, actor)` which validates the transition against the table, writes an audit row, and emits a domain event. Illegal transitions raise `IllegalStateTransition` and are logged as a defect, not swallowed.

### 9.1 `assessment`

```
                    ┌──────────┐
                    │  DRAFT   │  agency staged it, not yet payable
                    └────┬─────┘
                    issue│
                         ▼
   ┌──────────────►┌──────────┐◄──────────────┐
   │               │  ISSUED  │               │ un-settle
   │  amend        └──┬───┬───┘               │ (cheque returned,
   │  (v+1)           │   │                   │  payment recalled)
   │               part│   │full               │
   │                   ▼   │                   │
   │        ┌───────────────┐                 │
   ├────────│PARTIALLY_PAID │──full───────────┼──►┌──────────┐
   │        └───────┬───────┘                 └───│ SETTLED  │
   │                │                             └────┬─────┘
   │        overdue │ (due_date passed, balance>0)      │
   │                ▼                                   │ close period
   │        ┌───────────────┐                            ▼
   ├────────│   OVERDUE     │──full/part──►(SETTLED / PARTIALLY_PAID)
   │        └───────┬───────┘                     ┌──────────┐
   │                │ expiry_date passed          │  CLOSED  │ (immutable)
   │                ▼                             └──────────┘
   │        ┌───────────────┐
   │        │    EXPIRED    │──regenerate──►(new assessment, new PSID)
   │        └───────────────┘
   │
   │  ┌────────────┐        ┌────────────┐        ┌──────────────┐
   └──│  AMENDED   │        │ CANCELLED  │        │ WRITTEN_OFF  │
      │ (superseded│        │ (agency    │        │ (approved    │
      │  by v+1)   │        │  withdrew) │        │  write-off)  │
      └────────────┘        └────────────┘        └──────────────┘
```

| Rule | Detail |
|---|---|
| Amendment | Never mutate a paid assessment's amounts in place. Create version `v+1`, keep the **same PSID**, mark v as `AMENDED`, carry allocations forward. Amending downward below what has already been paid triggers an automatic overpayment (§14.2). |
| Cancellation | Only from `DRAFT`, `ISSUED`, `OVERDUE`, `EXPIRED` with `allocated = 0`. If any money has been applied, the agency must issue a refund instead — cancellation is not a way to make money disappear. Enforce this as a guard, not a convention. |
| Expiry | Set by scheduler **and** computed on read. An expired assessment is not payable but remains resolvable so the payer gets `PAYABLE_EXPIRED` rather than `NOT_FOUND`. The difference matters enormously to a confused citizen at an ATM. |
| Un-settle | `SETTLED → PARTIALLY_PAID/ISSUED` is legal and necessary (cheque return, recall, chargeback). It **must** reverse the receipt, re-close the service gate, and notify. Many platforms make settled a terminal state and then cannot handle a bounced cheque; do not be one of them. |
| Write-off | Requires maker-checker, a reason code, and a journal entry. Never silently zero a balance. |
| Closed | After fiscal-period close, the assessment is immutable. Post-close corrections go to the current period with a reference to the closed one (§13.6). |

### 9.2 `request_to_pay`

```
CREATED ──emit──► SENT ──ack──► DELIVERED ──presented──► PRESENTED
                    │              │                        │
                    │timeout       │undeliverable           ├─accept──────► ACCEPTED ──credit──► FULFILLED
                    ▼              ▼                        │                  │
                 FAILED      UNDELIVERABLE                  ├─accept_future─► ACCEPTED_FUTURE_DATED
                                                            │                  │ execution date
                                                            ├─accept_partial► ACCEPTED_PARTIAL ──credit──► FULFILLED_PARTIAL
                                                            │
                                                            ├─decline───────► DECLINED   (terminal; do NOT auto-retry)
                                                            │
                                                            └─no response───► EXPIRED ──remind──► (new RtP, linked)
                                                                                 │
                                        agency withdraws ──► CANCELLED           └─late credit──► FULFILLED_LATE

Any non-terminal state + agency cancel  ──► CANCELLED
```

Terminal: `FULFILLED`, `FULFILLED_PARTIAL`, `FULFILLED_LATE`, `DECLINED`, `CANCELLED`, `FAILED`, `UNDELIVERABLE`. `EXPIRED` is terminal for the RtP but a new linked RtP may be created (`rtp.reminder_of_id`).

### 9.3 `payment_intent`

```
CREATED ──authorise──► AUTHORISED ──capture──► CAPTURED ──apply──► COMPLETED
   │                        │                     │
   │ quote expires          │ payer abandons      │ capture fails
   ▼                        ▼                     ▼
EXPIRED                 ABANDONED              FAILED ──late credit──► COMPLETED_LATE
```

An intent holds no money and blocks nothing. `EXPIRED` and `FAILED` intents **must still accept a late credit** and transition to `COMPLETED_LATE`. Rejecting late money is the most expensive mistake available in this domain: the payer has been debited, so a rejection turns a solved problem into a complaint, an unapplied receipt, and a manual refund.

### 9.4 `payment` — including the `UNCERTAIN` state

```
                  ┌───────────┐
                  │ INITIATED │  (outbound, or inbound awaiting confirmation)
                  └─────┬─────┘
        ┌───────────────┼──────────────────┐
        │ confirmed     │ no response      │ definite reject
        ▼               ▼                  ▼
  ┌───────────┐   ┌───────────┐      ┌──────────┐
  │ CONFIRMED │   │ UNCERTAIN │      │  FAILED  │
  └──┬────┬───┘   └─────┬─────┘      └──────────┘
     │    │             │ pacs.028 / advice / statement
     │    │             ├──found paid──────► CONFIRMED
     │    │             ├──found not paid──► FAILED
     │    │             └──unresolved > N───► STUCK (ops queue, alarm)
     │    │
     │    │ cheque cleared
     │    ├──────────────────► CONFIRMED (finality FINAL)
     │    │
     │    │ reversal / return / recall / chargeback
     │    └──────────────────► REVERSED ──partial──► PARTIALLY_REVERSED
     │
     │ settlement cycle closes
     └──────────────────────► SETTLED   (settlement_batch SETTLED; payment stays CONFIRMED,
                                          settlement is tracked on the batch, not the payment)
```

**`UNCERTAIN` is the most important state in the whole platform, and the one most designs omit.** It exists because a payment API call can time out with the money already moved. The rules:

1. Any capture attempt that does not return a definite success or definite failure lands in `UNCERTAIN`. Never guess.
2. `UNCERTAIN` payments are **never** shown to a payer as failed. Show "we're confirming your payment" with an expected resolution time.
3. A resolver job works the `UNCERTAIN` queue with escalating strategies: (a) rail status enquiry (`pacs.028`); (b) aggregator advice; (c) intraday statement (`camt.052`); (d) end-of-day statement (`camt.053`); (e) human investigation.
4. `UNCERTAIN` is never a response to a switch (§8.6).
5. Alarm on queue depth and on age. `UNCERTAIN > 30 min` is a P2 incident; `> 4 h` is P1.
6. Track `uncertain_resolution_source` on resolution — it tells you which upstream integration is unreliable, which is exactly the evidence you need for a vendor conversation.

### 9.5 `instrument` (cheque)

```
LODGED ──validate──► PENDING_PRESENTMENT ──present──► IN_CLEARING ──┬──► CLEARED
   │                        │                                        │
   │                        │ post-dated                             └──► RETURNED ──represent──► IN_CLEARING
   │                        ▼                                                 │
   │                 HELD_POST_DATED ──date reached──► PENDING_PRESENTMENT     └──► WRITTEN_OFF
   │
   ├──► REJECTED_AT_LODGEMENT   (stale, altered, amount mismatch, invalid drawee)
   └──► STOPPED                 (stop payment instructed before presentment)
```

`RETURNED → IN_CLEARING` (re-presentment) is permitted a configurable number of times (`[A]` typically once) and only for reasons that are re-presentable (insufficient funds yes; signature differs or account closed no). Encode re-presentability in the return-reason table rather than in code.

### 9.6 `settlement_batch`

```
OPEN ──cutoff──► PENDING_NETTING ──net──► NETTED ──instruct──► INSTRUCTED
                                                                   │
                        ┌──────────────────────────────────────────┤
                        ▼                                          ▼
                    SETTLED  (treasury/rail confirmed)         SETTLEMENT_FAILED
                        │                                          │ retry
                        ▼                                          └──► PENDING_NETTING
                   RECONCILED  (three-way tie achieved)
                        │
                        ▼
                     CLOSED  (period locked)
```

### 9.7 `recon_break`

```
OPEN ──assign──► INVESTIGATING ──propose──► PENDING_APPROVAL ──approve──► RESOLVED
  │                    │                          │                          │
  │                    │                          └──reject──► INVESTIGATING │
  │                    │                                                     │
  │                    ├──auto-match on later data──────────────────────────►│
  │                    └──escalate──► ESCALATED ──resolve──────────────────►│
  │                                                                          ▼
  └──auto-resolve (self-clearing timing break)───────────────────────► AUTO_RESOLVED
                                                                            │
                                        aged past policy ──► WRITTEN_OFF ───┘
```

Every transition out of `OPEN` records an actor. `WRITTEN_OFF` requires maker-checker plus an amount within the approver's authority limit.

### 9.8 `refund`

```
REQUESTED ──validate──► PENDING_APPROVAL ──approve──► APPROVED ──execute──► PROCESSING
    │                         │                                                │
    │                         └──reject──► REJECTED                 ┌──────────┼──────────┐
    │                                                              ▼          ▼          ▼
    └──► CANCELLED (by requester before approval)              COMPLETED   RETURNED   FAILED
                                                                              │ (beneficiary
                                                                              │  account bad)
                                                                              ▼
                                                                        PENDING_DETAILS
```

---

## 10. Ledger & Accounting Design

### 10.1 Why a real double-entry ledger, in a demo

Because the first question a bank or treasury reviewer asks is *"where is the money right now, and can you prove it?"* A status column cannot answer that. A double-entry ledger answers it in one query, and it makes every subsequent conversation — settlement, recon, refunds, dishonour — mechanical rather than argumentative. It is also, in practice, less code than the alternative once exceptions arrive.

### 10.2 Core principles

1. **Append-only.** Journals are never updated or deleted. Corrections are new entries.
2. **Balanced.** `SUM(debits) = SUM(credits)` per entry, enforced by constraint. Reject unbalanced entries at write time.
3. **Every entry has a value date and a posting timestamp.** Backdating is allowed only into an open period, and only with an audit record.
4. **Every entry cites its cause.** `source_type` + `source_id` + `event_type`. No orphan journal entries, ever.
5. **Idempotent posting.** `UNIQUE (source_type, source_id, event_type, sequence)` makes replay a no-op. This is what lets you safely re-run a failed apply job.
6. **Multi-currency ready, single-currency in use.** Every account and line carries a currency; never mix currencies within an entry without an explicit FX pair of lines.
7. **Balances are derived.** Materialise `account_balance_daily` for speed but always keep the journal authoritative and provide a reperformance endpoint.

### 10.3 Platform chart of accounts

Account codes are platform-internal and distinct from government revenue heads. Both exist; they meet in the settlement and scroll layer.

| Code | Account | Type | Normal | Purpose |
|---|---|---|---|---|
| `1010` | Cash in Till — {branch} | Asset | Dr | OTC cash held |
| `1020` | Cheques in Hand | Asset | Dr | Lodged, not presented |
| `1030` | Cheques in Clearing | Asset | Dr | Presented, not cleared |
| `1100` | Collection Bank Account — {bank} | Asset | Dr | Pooled collection account (Shape A) |
| `1150` | Rail Settlement Receivable — {rail} | Asset | Dr | Confirmed on rail, not yet settled in the cycle |
| `1200` | Agent Float Receivable — {agent} | Asset | Dr | Agent/branchless |
| `1300` | Card Acquirer Receivable | Asset | Dr | Card settlement lag |
| `1900` | Suspense — Recon Investigation | Asset | Dr | Temporary, must be zero at period close |
| `2010` | **Agency Payable — {agency}** | Liability | Cr | **The core liability: money owed to the government** |
| `2015` | Agency Payable (Provisional) — {agency} | Liability | Cr | Provisional credits (uncleared cheques) |
| `2020` | **Unapplied Receipts** | Liability | Cr | Money received, not allocated |
| `2030` | Overpayment Payable — {agency} | Liability | Cr | Surplus awaiting refund or credit-on-account |
| `2040` | Refundable Deposits — {agency} | Liability | Cr | Tender/earnest money (§15.6) |
| `2050` | Refunds Payable | Liability | Cr | Approved, not yet paid out |
| `2060` | Unclaimed Funds | Liability | Cr | Aged unapplied receipts per policy |
| `2100` | Fee Payable to Channel Partner | Liability | Cr | Interchange/commission owed out |
| `2200` | Tax on Fees Payable | Liability | Cr | Sales tax on services collected on the fee `[A]` |
| `4010` | **Platform Fee Income** | Income | Cr | The operator's revenue |
| `4020` | Dishonour Charge Income | Income | Cr | Where the operator (not the agency) keeps it |
| `5010` | Rail/Scheme Cost | Expense | Dr | |
| `5020` | Channel Commission Expense | Expense | Dr | |
| `5900` | **Cash Over/Short** | Expense | Dr | Till differences; must be explained, never netted away |
| `5910` | Recon Write-off | Expense | Dr | Approved break write-offs |
| `3900` | **Control — Unbalanced Detected** | Equity | — | Should never carry a balance. Alarm if non-zero. |

### 10.4 `journal_entry` / `journal_line`

| `journal_entry` field | Type |
|---|---|
| `id` | UUID PK |
| `entry_no` | BIGSERIAL (gapless, per-agency sequence) |
| `event_type` | VARCHAR(40) — see §10.6 |
| `source_type` / `source_id` | VARCHAR(30) / UUID |
| `agency_id` | FK NULL |
| `value_date` | DATE |
| `posted_at` | TIMESTAMPTZ |
| `narrative` | VARCHAR(300) |
| `reversal_of_entry_id` | FK NULL |
| `approval_id` | FK NULL (required for manual entries) |
| `correlation_id` | UUID |
| `hash_prev` / `hash_self` | BYTEA — hash chain over `(entry_no, lines, hash_prev)` |

| `journal_line` field | Type |
|---|---|
| `id`, `entry_id` | |
| `seq` | SMALLINT |
| `account_code` | FK |
| `direction` | ENUM `DR \| CR` |
| `amount_minor` | BIGINT > 0 (never signed; direction carries the sign) |
| `currency` | CHAR(3) |
| `revenue_head_id` | FK NULL — **head-level dimension on the liability line, so head-wise settlement is a ledger query, not a spreadsheet** |
| `dimension` | JSONB — `{channel, rail, branch, product, payer_type}` for analytics |

**Hash chaining.** `hash_self = SHA256(entry_no || canonical_json(lines) || hash_prev)`. A `GET /internal/ledger/verify-chain` endpoint walks the chain and reports the first break. This is a genuinely impressive 20-second demo moment: tamper with a row in the database directly, then run the verifier and watch it name the entry.

### 10.5 Balanced-entry enforcement

```sql
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE dr BIGINT; cr BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='DR' THEN amount_minor END),0),
         COALESCE(SUM(CASE WHEN direction='CR' THEN amount_minor END),0)
    INTO dr, cr FROM journal_line WHERE entry_id = NEW.entry_id;
  IF dr <> cr THEN
    RAISE EXCEPTION 'Unbalanced journal entry %: DR % <> CR %', NEW.entry_id, dr, cr;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced
  AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Immutability
CREATE RULE je_no_update AS ON UPDATE TO journal_entry DO INSTEAD NOTHING;
CREATE RULE je_no_delete AS ON DELETE TO journal_entry DO INSTEAD NOTHING;
CREATE RULE jl_no_update AS ON UPDATE TO journal_line  DO INSTEAD NOTHING;
CREATE RULE jl_no_delete AS ON DELETE TO journal_line  DO INSTEAD NOTHING;
```

The `DEFERRABLE INITIALLY DEFERRED` constraint trigger is the key detail: it fires at commit, so a multi-line entry inserted row by row inside one transaction is checked once, as a whole, rather than failing on the first line.

### 10.6 Journal templates — one per business event

**This table is the specification for the ledger. Implement it literally as configuration, keyed by `event_type`, and test each template with a golden-file assertion.**

| # | Event | Debit | Credit | Notes |
|---|---|---|---|---|
| T01 | `COLLECT_RAIL_CONFIRMED` (Shape A) | `1150` Rail Settlement Receivable | `2010` Agency Payable | Money confirmed on rail, not yet netted |
| T02 | `RAIL_CYCLE_SETTLED` | `1100` Collection Bank | `1150` Rail Settlement Receivable | DNS cycle lands `[V]` Raast settles in PRISM on a DNS basis in intraday cycles |
| T03 | `COLLECT_PASS_THROUGH` (Shape B) | *memo only* | *memo only* | No platform balance-sheet impact. Post to a memo ledger (`account_class='MEMO'`) so reporting still works. |
| T04 | `COLLECT_CASH_OTC` | `1010` Cash in Till | `2010` Agency Payable | |
| T05 | `CASH_DEPOSITED_TO_BANK` | `1100` Collection Bank | `1010` Cash in Till | |
| T06 | `CHEQUE_LODGED` (no provisional credit) | `1020` Cheques in Hand | `2015` Agency Payable (Provisional) | Balance-sheet visible, not yet agency revenue |
| T07 | `CHEQUE_PRESENTED` | `1030` Cheques in Clearing | `1020` Cheques in Hand | |
| T08 | `CHEQUE_CLEARED` | `1100` Collection Bank | `1030` Cheques in Clearing | |
| T09 | `PROVISIONAL_TO_FINAL` | `2015` Agency Payable (Provisional) | `2010` Agency Payable | On clearing |
| T10 | `CHEQUE_RETURNED` | `2015` Agency Payable (Provisional) | `1030` Cheques in Clearing | Plus reversal of allocations |
| T11 | `RECEIPT_UNAPPLIED` | `1100` / `1150` | `2020` Unapplied Receipts | No agency known yet |
| T12 | `UNAPPLIED_ALLOCATED` | `2020` Unapplied Receipts | `2010` Agency Payable | Requires `approval_id` when manual |
| T13 | `OVERPAYMENT_RECOGNISED` | `2010` Agency Payable | `2030` Overpayment Payable | Moves surplus out of agency revenue |
| T14 | `FEE_CHARGED_PAYER` | `1150`/`1100` (extra amount) | `4010` Platform Fee Income | Fee collected on top of the payable |
| T15 | `FEE_DEDUCTED_FROM_AGENCY` | `2010` Agency Payable | `4010` Platform Fee Income | Fee borne by the agency |
| T16 | `TAX_ON_FEE` | `4010` Platform Fee Income | `2200` Tax on Fees Payable | `[A]` provincial sales tax on services |
| T17 | `CHANNEL_COMMISSION` | `5020` Channel Commission Expense | `2100` Fee Payable to Channel Partner | |
| T18 | `SWEEP_TO_TREASURY` | `2010` Agency Payable | `1100` Collection Bank | **This is the entry that discharges the platform's obligation to the government** |
| T19 | `REFUND_APPROVED` | `2030`/`2010` | `2050` Refunds Payable | |
| T20 | `REFUND_PAID` | `2050` Refunds Payable | `1100` Collection Bank | |
| T21 | `PAYMENT_REVERSED` | `2010` Agency Payable | `1150`/`1100`/`1010` | Contra of T01/T04 |
| T22 | `CHARGEBACK_DEBITED` | `2010` Agency Payable | `1300` Card Acquirer Receivable | Agency bears it unless the operator indemnifies |
| T23 | `TILL_OVER` | `1010` Cash in Till | `5900` Cash Over/Short (credit side) | Physical cash exceeds recorded |
| T24 | `TILL_SHORT` | `5900` Cash Over/Short | `1010` Cash in Till | |
| T25 | `RECON_WRITE_OFF` | `5910` Recon Write-off | `1900`/`2020` | Maker-checker mandatory |
| T26 | `DEPOSIT_RECEIVED` | `1100`/`1150` | `2040` Refundable Deposits | Not revenue (§15.6) |
| T27 | `DEPOSIT_REFUNDED` | `2040` Refundable Deposits | `1100` Collection Bank | |
| T28 | `DEPOSIT_FORFEITED` | `2040` Refundable Deposits | `2010` Agency Payable | Deposit becomes revenue |
| T29 | `UNAPPLIED_AGED_TO_UNCLAIMED` | `2020` Unapplied Receipts | `2060` Unclaimed Funds | Per policy; **never to income** |
| T30 | `DISHONOUR_CHARGE_COLLECTED` | `1150`/`1100` | `4020`/`2010` | Depends on who keeps the charge |

### 10.7 Worked example — a multi-head tax payment

**Round numbers, chosen for legibility; this is not a row in the demo data.** For the real thing see payment `P260000E` in `demo-data/payments.csv` — PKR 943,880.00 over internet banking on Raast, split `B01101` 920,000.00 / `B02388` 12,880.00 / `B02391` 11,000.00, with `fee_bearer=AGENCY` so no payer-borne fee lines.

Payer pays PKR 50,000 income tax (principal 42,000 + default surcharge 6,000 + penalty 2,000) via Raast APP, with a payer-borne convenience fee of PKR 50 plus 16% provincial sales tax on that fee (PKR 8). `[A]` fee and tax rates are illustrative.

Total debited from the payer: **PKR 50,058**.

**Entry 1 — `COLLECT_RAIL_CONFIRMED` (T01, T14, T16 combined into one balanced entry):**

| Line | Account | Dr | Cr | Revenue head |
|---|---|---|---|---|
| 1 | `1150` Rail Settlement Receivable — RAAST | 5,005,800 | | |
| 2 | `2010` Agency Payable — FBR | | 4,200,000 | `B01101` Income Tax on Companies |
| 3 | `2010` Agency Payable — FBR | | 600,000 | `B02388` Default Surcharge |
| 4 | `2010` Agency Payable — FBR | | 200,000 | `B02391` Penalty |
| 5 | `4010` Platform Fee Income | | 4,200 | |
| 6 | `2200` Tax on Fees Payable | | 800 | |
| | **Totals (paisa)** | **5,005,800** | **5,005,800** | |

Note lines 2–4: **one payment, three revenue heads, three ledger lines carrying the head dimension.** Head-wise settlement is now `SELECT revenue_head_id, SUM(...) FROM journal_line WHERE account_code='2010' AND ...` — no spreadsheet, no reconciliation-by-hand, and it ties to the allocations by construction.

**Entry 2 — `RAIL_CYCLE_SETTLED` (T02), same day, cycle 3:**

| Line | Account | Dr | Cr |
|---|---|---|---|
| 1 | `1100` Collection Bank — HBL | 5,005,800 | |
| 2 | `1150` Rail Settlement Receivable — RAAST | | 5,005,800 |

**Entry 3 — `SWEEP_TO_TREASURY` (T18), next morning:**

| Line | Account | Dr | Cr |
|---|---|---|---|
| 1 | `2010` Agency Payable — FBR | 5,000,000 | |
| 2 | `1100` Collection Bank — HBL | | 5,000,000 |

After the sweep, `2010` for this payment is zero, `4010` retains the operator's PKR 42, and `2200` retains the PKR 8 tax to remit. **Trial balance ties.** Show this on screen; it is the moment a sceptical reviewer relaxes.

### 10.8 Reperformance and control reports

Ship these five endpoints. Together they constitute the platform's own audit.

| Endpoint | Assertion |
|---|---|
| `GET /internal/control/trial-balance?date=` | `SUM(DR) = SUM(CR)` across all accounts |
| `GET /internal/control/allocation-integrity` | For every payment **in a live state** (`CONFIRMED`, `PARTIALLY_REVERSED`): `Σ applied allocations + unapplied = gross`. `REVERSED` and `UNCERTAIN` payments are excluded by design — a fully reversed payment has no applied allocations and no unapplied balance, and an `UNCERTAIN` payment has not yet been applied at all. The control must state its exclusion set explicitly rather than silently skipping rows. |
| `GET /internal/control/balance-rebuild` | Recomputed assessment balances byte-identical to cached |
| `GET /internal/control/ledger-vs-subledger` | `2010` per agency = `Σ` unswept allocations per agency |
| `GET /internal/ledger/verify-chain` | Hash chain intact from genesis |

Run all five on a schedule, surface pass/fail on the ops dashboard, and page on failure. In the demo, put them on one screen with green ticks — and then break one deliberately.

---

## 11. Cash Application & Payment Matching

Cash application is *deciding which obligations a receipt discharges*. Reconciliation (§12) is *proving the money is where the records say it is*. They are different problems and must be different modules; conflating them is a common and expensive design error, because it makes every recon break look like an allocation bug and vice versa.

### 11.1 The matching pipeline

```
Inbound money event
   │
   ▼
[1] IDENTIFY  ── link the payment to an intent / RtP / instrument / switch txn
   │            keys, in priority order: intent_reference · rail_e2e_id · UETR · RtP ref
   │            · switch STAN+RRN+acquirer+date · instrument id · bulk reference
   ▼
[2] DEDUPLICATE ── §14.5
   ▼
[3] DERIVE TARGETS ── which assessments does this money relate to?
   │            (a) explicit allocations on the intent / bulk file  → use them
   │            (b) the intent's payable set                         → use it
   │            (c) reference in structured remittance (RF/PSID)     → resolve
   │            (d) reference parsed from unstructured narrative     → resolve (§11.6)
   │            (e) payer identity → their open assessments          → waterfall
   │            (f) nothing usable                                   → UNAPPLIED
   ▼
[4] VALIDATE ── assessments open, same agency, same currency, channel eligible
   ▼
[5] ALLOCATE ── apply the waterfall (§11.3) down to line-item level
   ▼
[6] HANDLE RESIDUAL ── shortfall (partial) / surplus (over) per §11.4
   ▼
[7] POST ── journals (§10.6), update caches, emit events
   ▼
[8] EVIDENCE ── receipt, notifications, webhooks, service-gate token
```

Every step is idempotent and the whole pipeline is replayable from the payment record. Store the pipeline decision trail on the payment as `application_trace` JSONB — which step matched, on what key, with what confidence. When someone asks "why did this PKR 30,000 land on that challan?", you answer in five seconds instead of an afternoon.

### 11.2 Match keys and confidence

| Rank | Key | Confidence | Auto-apply? |
|---|---|---|---|
| 1 | `intent_reference` == `EndToEndId` | Exact | Yes |
| 2 | ISO 11649 `RF` reference, both check digits valid | Exact | Yes |
| 3 | PSID in structured remittance, Damm valid, assessment open | Exact | Yes |
| 4 | `rtp_reference` on an RtP-fulfilling credit | Exact | Yes |
| 5 | Switch `STAN+RRN+acquirer+date` | Exact | Yes |
| 6 | PSID extracted from unstructured narrative, Damm valid, **amount matches exactly** | High | Yes |
| 7 | PSID from narrative, Damm valid, amount differs | Medium | Yes, with residual handling |
| 8 | CRN/consumer number in narrative + amount matches one open assessment | Medium | Yes |
| 9 | Payer's debit account matches a payer with exactly one open assessment of the same amount | Low | **No — queue for review** |
| 10 | Fuzzy name match + amount + date proximity | Very low | **No — queue for review** |
| — | Nothing | None | `UNAPPLIED` |

**Rule: never auto-apply below "Medium".** A wrong auto-allocation is worse than an unapplied receipt, because the money is now on someone else's tax record, the platform has issued a false receipt, and unwinding it requires reversing a receipt that a third party may already have relied on. Unapplied money is merely late; misapplied money is a dispute.

### 11.3 Allocation waterfall

When a payment does not cover the full payable, order matters and must be configurable per product because different agencies have different legal positions on what a part-payment discharges.

| `allocation_waterfall` | Order | Typical use |
|---|---|---|
| `PENALTY_FIRST` | Fees → Penalty → Surcharge → Interest → Principal | Most tax authorities: protects the revenue's penalty claim |
| `PRINCIPAL_FIRST` | Principal → Interest → Surcharge → Penalty → Fees | Payer-friendly; reduces further interest accrual |
| `OLDEST_FIRST` | By `tax_period` ascending, then by `allocation_priority` | Arrears-heavy products (property tax, water) |
| `PRO_RATA` | Proportional across all open line items | Rare; used where heads must move together |
| `EXPLICIT_ONLY` | No inference; unallocated remainder becomes unapplied | Bulk corporate files, customs |

Algorithm (implement exactly; note the two subtleties flagged):

```
function allocate(payment, targets[], waterfall, options):
    remaining = payment.gross_amount_minor - payment.fee_if_deducted
    allocations = []

    # 1. Explicit instructions always win
    if options.explicit_allocations:
        for a in options.explicit_allocations:
            amt = min(a.amount, remaining, line_balance(a.line_item_id))
            if amt > 0: allocations.append((a.line_item_id, amt, 'EXPLICIT'))
            remaining -= amt
        if waterfall == 'EXPLICIT_ONLY': return finish(allocations, remaining)

    # 2. Order the remaining open line items
    lines = open_line_items(targets)
    lines = sort(lines, by = waterfall_comparator(waterfall))

    # 3. Greedy fill
    for line in lines:
        if remaining <= 0: break
        amt = min(remaining, line.balance_minor)
        if amt > 0:
            allocations.append((line.id, amt, 'WATERFALL'))
            remaining -= amt

    return finish(allocations, remaining)

function finish(allocations, remaining):
    # SUBTLETY 1: full-settlement check must respect underpay tolerance PER ASSESSMENT,
    # not on the payment total, or a payment across two bills can wrongly settle both.
    for asmt in affected_assessments(allocations):
        if asmt.balance_after <= product(asmt).underpay_tolerance_minor:
            post_rounding_relief_line(asmt)   # a ROUNDING line item keeps the ledger balanced
            mark_settled(asmt)

    # SUBTLETY 2: surplus is never left on the payment silently.
    if remaining > 0:
        handle_surplus(remaining)   # §11.4
    return allocations
```

**Rounding relief.** If tolerance settles a bill with PKR 0.40 outstanding, the ledger would not balance against the assessed amount. Post a `ROUNDING` line item of −0.40 to the assessment so `Σ line items = assessed` still holds, and credit a `Rounding Relief` head. Without this the trial balance drifts by pennies and, months later, nobody can explain why.

### 11.4 Over-payment, under-payment, and residuals

| Situation | Detection | Handling per `overpay_treatment` / tolerance |
|---|---|---|
| Under-payment within `underpay_tolerance_minor` | `balance ≤ tolerance` | Settle in full, post rounding relief |
| Under-payment beyond tolerance, `allow_partial=true` | | `PARTIALLY_PAID`; new balance; surcharge continues to accrue on the balance only |
| Under-payment beyond tolerance, `allow_partial=false` | | **Two defensible options — make it configurable per product:** (a) `REJECT_AND_RETURN` — return the funds, no allocation (correct for service-gating products); (b) `HOLD_AS_UNAPPLIED` — hold as unapplied, notify the payer to top up (kinder, and correct for taxes). Default `HOLD_AS_UNAPPLIED`; **never silently keep money against an unsettled bill with no record.** |
| Over-payment within `overpay_tolerance_minor` | | `ABSORB` — surplus becomes revenue on a `Rounding` head |
| Over-payment beyond tolerance, `CREDIT_ON_ACCOUNT` | | Surplus to `2030` Overpayment Payable, linked to `payer_account`; auto-applies to the next assessment for that product |
| Over-payment beyond tolerance, `AUTO_REFUND` | | Create a `refund` in `PENDING_APPROVAL`; refund to the original debit account |
| Over-payment beyond tolerance, `REJECT` | | Return the entire payment; do not partially apply. Rare, but required by some duty regimes. |
| Duplicate payment | §14.5 | Full auto-refund of the later payment, regardless of `overpay_treatment` |

### 11.5 Multi-bill payments

A payer pays PKR 18,500 against three traffic challans of 5,000, 8,500, and 7,000 (total 20,500).

- With `EXPLICIT` allocations from the app: apply as instructed; if the total instructed exceeds the money received, apply in the payer's stated order until exhausted and leave the remainder as a shortfall on the last item.
- With no explicit instruction and `OLDEST_FIRST`: 5,000 → challan A (settled), 8,500 → challan B (settled), 5,000 → challan C (partial, 2,000 outstanding).
- **Always tell the payer exactly what was and was not settled**, on the receipt and in the notification. A receipt saying only "PKR 18,500 received" for three challans, one still open, produces a support call and a driver who thinks they are clear when they are not.

### 11.6 Narrative parsing for unstructured remittance

Required because RTGS and some bank transfers give you a free-text field and a payer who types like a human.

```
Pipeline:
 1. Normalise:      uppercase; collapse whitespace; map O→0 and I/l→1 ONLY inside
                    candidate numeric runs; strip punctuation except / and -
 2. Extract:        regex all digit runs of length 8..20, and RF-prefixed tokens
 3. Validate:       for each candidate — matching reference_scheme? checksum valid?
 4. Resolve:        look up in resolution_index; keep only open, same-currency hits
 5. Score:          checksum-valid (+50) · assessment open (+20) · amount exact (+25)
                    · amount within 1% (+10) · payer's prior payment history to this
                    product (+15) · agency name appears in narrative (+10)
 6. Decide:         single candidate ≥ 70  → auto-apply
                    single candidate 40-69 → queue for review with a suggestion
                    multiple ≥ 70          → queue; NEVER guess between two valid PSIDs
                    none                   → UNAPPLIED
 7. Record:         store candidates, scores, and the decision in application_trace
```

Test corpus for the demo — put these in the seed data and assert the outcome of each:

| Narrative | Expected |
|---|---|
| `PSID 41011300000190123 INCOME TAX` | Auto-apply, exact |
| `TAX PYMT 4101-1300-0001-9012-3` | Auto-apply after normalisation |
| `RF3741011300000190123 PSCA` | Auto-apply via RF |
| `41011300000190124` (bad check digit) | No candidate → UNAPPLIED with reason `CHECKSUM_FAILED` |
| `TOKEN TAX LEA 17 1000` | Resolve by vehicle reg, score 45 → review queue |
| `TAX PAYMENT AHMED` | UNAPPLIED, break raised |
| `PAYMENT FOR 41011300000190123 AND 71011800000183627` | Two valid PSIDs → review queue, never guess |

---

## 12. Reconciliation Engine

The named requirement, and the part most demos fake. Do not fake it. Build the engine, plant the breaks, and let the reviewer watch it find them.

### 12.1 What reconciles against what

Reconciliation is **N-way**, though "three-way" is the canonical core:

```
   ┌─────────────────────┐   ┌──────────────────────┐   ┌────────────────────┐
   │  A. PLATFORM LEDGER │   │  B. RAIL / SWITCH    │   │  C. BANK STATEMENT │
   │  payments +         │◄─►│  settlement report   │◄─►│  camt.053          │
   │  allocations +      │   │  (Raast cycle file,  │   │  (the account the  │
   │  journals           │   │   1LINK settlement)  │   │   money landed in) │
   └──────────┬──────────┘   └──────────────────────┘   └────────────────────┘
              │
              ├──► D. AGENCY SUB-LEDGER   (what the agency thinks it is owed / received)
              ├──► E. TREASURY / SCROLL ACK (what the government booked)
              └──► F. CHANNEL PARTNER REPORT (what the bank/agent says it collected)
```

| Pair | Question answered | Failure means |
|---|---|---|
| A↔B | Did the rail agree with our record of every transaction? | A payment we think happened, didn't (or vice versa) |
| B↔C | Did the netted cycle actually land in the bank account? | Settlement failure or a fee we didn't expect |
| A↔C | Is every rupee in the bank explained by a payment? | Unidentified credit, or a phantom payment |
| A↔D | Does the agency agree with our head-wise position? | Assessment or allocation disagreement |
| A/D↔E | Did the treasury book what we sent? | Scroll rejection, head misclassification |
| A↔F | Did the channel collect what it says it did? | Agent float or till discrepancy |

### 12.2 Reconciliation run model

| `recon_run` field | Notes |
|---|---|
| `id`, `run_no` | |
| `recon_type` | `THREE_WAY_DAILY \| RAIL_CYCLE \| SWITCH_DAILY \| BANK_STATEMENT \| AGENCY_SUBLEDGER \| TILL_CLOSE \| SCROLL_ACK \| INTRADAY` |
| `business_date` | The value date being reconciled |
| `agency_id` / `rail` / `channel_partner_id` | Scope |
| `sources[]` | Which files/queries participated, with row counts and hashes |
| `status` | `PENDING \| INGESTING \| MATCHING \| COMPLETE \| FAILED` |
| `matched_count` / `matched_amount_minor` | |
| `break_count` / `break_amount_minor` | |
| `auto_match_rate_pct` | **The headline KPI. Target ≥ 99.5%.** |
| `started_at` / `completed_at` | |
| `control_totals` | JSONB per source: count, sum, hash |
| `is_reperformable` | A run must be re-runnable and produce identical results |

**Ingestion rules — these prevent the classic recon disasters:**

1. **Never ingest the same file twice.** `UNIQUE (source_type, file_hash)`. If a partner resends a corrected file, it must arrive as a new version and supersede the old run explicitly, with both retained.
2. **Validate control records before matching.** If the file's trailer says 1,240 rows totalling PKR 84,392,100 and you parsed 1,239 rows, **fail the run**. Do not reconcile a partially-parsed file — a truncated file will produce dozens of spurious "missing payment" breaks and destroy trust in the engine.
3. **Keep raw source records.** `recon_source_record` stores the original line verbatim plus the parsed fields. Investigations always come back to the raw line.
4. **Time-zone discipline.** Partners send local dates in inconsistent formats. Normalise to `Asia/Karachi` business dates on ingest and record the assumed format per partner in configuration, never in code.

### 12.3 Matching passes

Run passes in order; each pass only considers records still unmatched.

| Pass | Key | Type | Notes |
|---|---|---|---|
| P1 | `rail_e2e_id` / `EndToEndId` | Exact, 1:1 | Should catch 95%+ |
| P2 | UETR | Exact, 1:1 | |
| P3 | `STAN + RRN + acquirer + date` | Exact, 1:1 | Switch-originated |
| P4 | `payment_reference` in the statement narrative | Exact, 1:1 | |
| P5 | `amount + value_date + payer_bank_bic` | Exact, 1:1 — **only if unique** | If multiple candidates, do not match; leave for P8 |
| P6 | Sum of platform payments = one statement credit | 1:N (aggregated settlement) | Netted cycle credits. Requires subset-sum with a bounded search (§12.4) |
| P7 | One platform payment = sum of statement credits | N:1 | Split settlement, partial funding |
| P8 | `amount ± tolerance + date ± window` | Fuzzy | **Proposes**, never auto-confirms |
| P9 | Residual | — | Everything left becomes a break |

**Fee-aware matching.** The bank credit will frequently be *net of a fee* while the platform recorded gross. Matching must apply an expected-fee model per rail/channel and match `gross − expected_fee == credit`, flagging `FEE_VARIANCE` when the implied fee differs from the contracted one. Fee variance is a real and commonly-missed source of money leakage — a 0.02% MDR error across a national platform is a large number, and nobody notices without this check.

### 12.4 Bounded subset-sum for aggregated credits (Pass P6)

Naive subset-sum is exponential. Constrain it, and be honest in the design about the fallback:

1. Partition candidate payments by `(value_date, rail, agency)`.
2. Sort descending by amount; greedily fill toward the target.
3. Cap the search: ≤ 25 candidates, ≤ 200 ms per credit, depth-limited DFS with memoisation on the remaining target.
4. Require the matched subset to be **unique**; if two distinct subsets hit the target, do not match — raise `AMBIGUOUS_AGGREGATION` for human review.
5. If the cap is hit without a match, degrade to a control-total comparison for the whole cycle and raise a single `CYCLE_VARIANCE` break rather than hundreds of per-transaction breaks. **One accurate break beats two hundred noisy ones**, and this is the difference between an ops team that uses the tool and one that ignores it.

In practice the rail's own cycle file lists its constituent transactions, so P6 should rarely be needed — but it is needed for bank statements that show only a net credit, which is common.

### 12.5 Break taxonomy

**Implement all of these.** The demo data plants **11 breaks spanning the first nine codes** — `B01` and `B05` appear twice each — so the engine is tested on repetition as well as coverage (§24.3).

| Code | Break type | Definition | Typical cause | Default resolution |
|---|---|---|---|---|
| `B01` | `UNMATCHED_CREDIT_IN_BANK` | Money in the bank statement with no platform payment | Reference-less push; a payment the platform never received notification of | Investigate narrative → allocate or return (§8.15) |
| `B02` | `UNMATCHED_PAYMENT_IN_PLATFORM` | Platform payment with no corresponding bank/rail credit | Payment recorded but rail failed; premature confirmation; duplicate platform record | Verify with rail (`pacs.028`); reverse if never funded |
| `B03` | `AMOUNT_MISMATCH` | Matched pair, different amounts | Fee deducted at source; partial funding; FX; keying error | Post fee variance or adjust with approval |
| `B04` | `DUPLICATE_IN_SOURCE` | Same transaction twice in one source | Partner resent; switch retry | Suppress the duplicate; keep evidence |
| `B05` | `TIMING_DIFFERENCE` | Present in one source on D, the other on D+1 | Cut-off straddle | **Auto-resolves** on the next run; must not alarm |
| `B06` | `UNAPPLIED_RECEIPT_AGED` | Confirmed money unallocated beyond SLA | Bad reference | Manual allocation or return |
| `B07` | `FEE_VARIANCE` | Implied fee ≠ contracted fee | Wrong rate card; tier boundary; tax on fee | Recompute; raise with the partner; adjust |
| `B08` | `SETTLEMENT_SHORTFALL` | Cycle net ≠ sum of constituents | Rail excluded a transaction; a return netted in | Reconcile at transaction level within the cycle |
| `B09` | `SCROLL_REJECTED` | Treasury rejected a scroll line | Invalid/closed revenue head; wrong fiscal period | Reclassify head; re-submit; **the money is already banked, so this is a classification break, not a cash break** |
| `B10` | `TILL_OVER_SHORT` | Physical cash ≠ recorded | Teller error, theft | Supervisor investigation; post to `5900` |
| `B11` | `CHEQUE_UNRETURNED_UNCLEARED` | Cheque in clearing past expected date with no outcome | Lost in clearing | Chase drawee bank; consider re-presentment |
| `B12` | `AGENCY_SUBLEDGER_VARIANCE` | Agency's head-wise total ≠ platform's | Assessment amended after payment; agency posted manually | Head-level walk-down |
| `B13` | `ORPHAN_ALLOCATION` | Allocation exists with no valid payment or assessment | **A bug.** Should be impossible if FKs are right | Escalate to engineering, not to ops |
| `B14` | `LEDGER_IMBALANCE` | Trial balance does not tie | **A bug.** | P1 incident |
| `B15` | `AMBIGUOUS_AGGREGATION` | Multiple valid subsets match a credit | Coincidental amounts | Manual selection |
| `B16` | `REVERSAL_WITHOUT_ORIGINAL` | Reversal received for a payment never seen | Switch timeout on the original | Hold as pending; auto-match when the original arrives (§4.2) |
| `B17` | `STALE_UNCERTAIN` | `UNCERTAIN` payment unresolved past SLA | Integration failure | Escalate per §9.4 |

### 12.6 `recon_break` record

| Field | Notes |
|---|---|
| `id`, `run_id`, `break_code` | |
| `severity` | `INFO \| LOW \| MEDIUM \| HIGH \| CRITICAL` — derived from amount × type × age |
| `amount_minor` | The unexplained difference, signed |
| `currency` | |
| `business_date` | |
| `agency_id`, `rail`, `channel` | Scope for routing |
| `source_a_record_id` / `source_b_record_id` | Either may be null (that's the point of a break) |
| `payment_id` / `assessment_id` | When known |
| `narrative_raw` | The raw line from the source — investigators live here |
| `suggested_resolution` | JSONB from the engine's own analysis, with confidence |
| `status` | §9.7 |
| `assigned_to_user_id`, `sla_due_at`, `age_days` | |
| `resolution_type` | `MATCHED_LATE \| ALLOCATED \| REVERSED \| ADJUSTED \| WRITTEN_OFF \| RETURNED_TO_REMITTER \| NO_ACTION_TIMING \| PARTNER_CORRECTED` |
| `adjustment_id`, `approval_id` | |
| `resolved_at`, `resolved_by_user_id`, `resolution_note` | |

### 12.7 Break ageing, SLA, and escalation

| Age bucket | Label | Action |
|---|---|---|
| 0–1 business day | Current | Auto-resolution attempts continue |
| 2–3 | Ageing | Assigned to an analyst |
| 4–7 | Overdue | Supervisor visibility; daily standing report |
| 8–30 | Escalated | Head of Ops; agency notified if agency-side |
| 31–90 | Critical | Written provision considered; regulator-reportable if material `[A]` |
| > 90 | Legacy | Write-off with maker-checker, or transfer to unclaimed funds |

SLA by severity `[A]` (make configurable): `CRITICAL` 4 h, `HIGH` 1 business day, `MEDIUM` 3, `LOW` 5, `INFO` best-effort.

### 12.8 Adjustment workflow (maker-checker)

```
Analyst (OPS_RECON_ANALYST)                Approver (OPS_RECON_APPROVER)
  │                                                    │
  ├─ investigate break                                 │
  ├─ select resolution_type                            │
  ├─ compose adjustment: accounts, amount, narrative   │
  ├─ system previews the journal entry ────────────────┤
  ├─ submit ──────────────────────────────────────────►│
                                                       ├─ review break + evidence + preview
                                                       ├─ check authority limit
                                                       ├─ APPROVE ──► post journal, close break
                                                       └─ REJECT  ──► back to analyst with a comment
```

Rules: `maker ≠ checker`, enforced in the database. Authority limits by role (`[A]` e.g. analyst proposes any amount; approver ≤ PKR 500,000; head of ops ≤ 5,000,000; above that, dual approval). Every adjustment produces exactly one journal entry, referenced from the break. Nothing may be adjusted in a closed period (§13.6).

### 12.9 Auto-resolution rules

Aggressive automation here is what gets the auto-match rate to 99.5%, but each rule must be narrow, logged, and reversible.

| Rule | Condition | Action |
|---|---|---|
| R1 Timing self-clear | `B05` and the counterpart appears in the next run | Auto-resolve `NO_ACTION_TIMING` |
| R2 Immaterial variance | `B03` and `|amount| ≤ auto_writeoff_threshold` (`[A]` PKR 10) and no pattern | Auto-adjust to `5910`, log |
| R3 Known fee variance | `B07` matches a configured fee-model exception | Auto-post fee variance |
| R4 Late arrival | `B02` and the rail confirms it settled in a later cycle | Auto-match |
| R5 Reversal reunion | `B16` and the original arrives within the window | Auto-pair and reverse |
| R6 Duplicate suppression | `B04` and the record is byte-identical to one already matched | Auto-suppress |

**Guard rail:** cap auto-resolution at a configured count and value per run (`[A]` e.g. 500 breaks and PKR 100,000 per day). If a run exceeds the cap, stop auto-resolving and alarm — a spike in auto-resolutions is nearly always a systemic problem being quietly papered over, and the cap is what makes you look at it.

### 12.10 Reconciliation outputs

| Report | Content | Audience |
|---|---|---|
| Daily Recon Certificate | Per agency, per date: opening unreconciled, transactions, matched, breaks, closing; signed off by a named user | Agency finance, audit |
| Break Register | Every open break with age, owner, amount, suggested action | Ops |
| Auto-match Rate Trend | Rate by rail/channel/agency over time | Management, engineering |
| Unapplied Receipts Ageing | The stranded-money report | Ops, compliance, client-money |
| Fee Variance Report | Contracted vs implied fees by partner | Commercial |
| Head-wise Position | Platform vs agency sub-ledger by revenue head | Agency, treasury |
| Control Totals Pack | The five §10.8 assertions, pass/fail, per day | Audit, regulator |
---

## 13. Settlement, Treasury Transfer, and Period Close

### 13.1 The two money movements — do not conflate them

| Movement | What it is | Who confirms it |
|---|---|---|
| **Interbank settlement** | The rail nets participants' positions and settles them. `[V]` Raast clears in Raast and settles in PRISM on a deferred net settlement basis in multiple intraday cycles. | The rail / PRISM |
| **Treasury transfer (sweep)** | The platform (or collecting bank) transfers collected funds into the government's designated account and files the scroll. | Treasury / agency |

A payment can be payer-final, interbank-settled, and *still not swept to the government*. Three different states; three different reports; three different reconciliations. Every serious P2G conversation eventually turns on this distinction, so model it explicitly and put all three on one screen.

### 13.2 `settlement_cycle`

| Field | Notes |
|---|---|
| `id`, `rail`, `business_date`, `cycle_no` | `[V]` Raast has multiple cycles per business day; number and times are scheme-set — `[A]` confirm actual times with SBP |
| `window_open_at` / `cutoff_at` | |
| `status` | `OPEN \| CUT_OFF \| NETTING \| SETTLED \| FAILED` |
| `gross_in_minor` / `gross_out_minor` / `net_minor` | |
| `participant_position` | JSONB |
| `rail_settlement_ref` | The rail's own reference for the settlement |
| `settled_at` | |

**Because the rail is 24×7 `[V]` but settlement cycles are intraday, payments made after the last cycle settle in the first cycle of the next business day.** Payer finality is immediate; platform liquidity is not. Represent this honestly: `1150 Rail Settlement Receivable` is exactly the account that holds this gap, and its balance at any instant is a real, explainable number.

### 13.3 Value-date assignment and cut-offs

The single most consequential piece of logic in the platform, because tax deadlines are legal deadlines.

```
function assign_value_date(payment, product, agency):
    tz        = agency.timezone                     # Asia/Karachi
    local_ts  = payment.received_at in tz
    calendar  = business_calendar(agency.jurisdiction)
    cutoff    = product.cutoff_time
                  or agency.default_cutoff_time
                  or platform_default_cutoff        # e.g. 18:00 local  [A]

    if not calendar.is_business_day(local_ts.date):
        vd = calendar.next_business_day(local_ts.date)
        reason = 'NON_BUSINESS_DAY'
    elif local_ts.time > cutoff:
        vd = calendar.next_business_day(local_ts.date + 1)
        reason = 'AFTER_CUTOFF'
    else:
        vd = local_ts.date
        reason = 'SAME_DAY'

    # Fiscal-deadline protection: a legal deadline is a DATE, not a banking cut-off.
    # If the payer paid on the deadline date, the obligation is discharged on that date
    # even if the value date rolls forward for settlement purposes.
    obligation_date = local_ts.date

    store(payment, value_date=vd, obligation_discharge_date=obligation_date,
          cutoff_rule_version=..., cutoff_reason=reason)
```

**Two dates, deliberately.** `value_date` drives settlement, banking, and reconciliation. `obligation_discharge_date` drives surcharge, penalty, and whether the payer met a statutory deadline. Conflating them either penalises citizens who paid on time (unjust, and litigated) or misstates the bank position (wrong, and audited). Store the rule version that produced each so a decision made in June 2026 can be explained in 2029.

**Fiscal year boundary.** `[A]` Pakistan's fiscal year runs July–June. A payment at 23:58 on 30 June belongs to the closing year; one at 00:02 on 1 July does not. Around the boundary, log every value-date decision at INFO and produce a boundary-audit report of everything within ±2 hours of midnight.

### 13.4 Sweep to treasury

| # | Step | Detail |
|---|---|---|
| 1 | Determine sweepable balance per agency | `2010 Agency Payable` where the underlying payment is `finality=FINAL` **and** the cycle is `SETTLED`. **Never sweep provisional credits** — sweeping an uncleared cheque means the government has money that may un-arrive, and clawing it back from a treasury account is politically and operationally painful. |
| 2 | Apply sweep schedule | Per agency: `T+0 EOD`, `T+1 morning`, `WEEKLY`, or `ON_THRESHOLD` |
| 3 | Deduct agency-borne fees | Per `fee_bearer` (§15.5); produce a fee invoice |
| 4 | Compose the instruction | RTGS/Raast credit to `agency.treasury_account_iban`, referencing the scroll id |
| 5 | Maker-checker on the instruction | Above a threshold `[A]`, two approvers |
| 6 | Execute, capture the rail reference | `payment` with `direction=OUTBOUND` |
| 7 | Post T18 | Dr `2010` / Cr `1100` |
| 8 | Generate and transmit the scroll (§13.5) | Same reference as the instruction |
| 9 | Await treasury acknowledgement | Reconcile ack vs scroll → `B09` on rejection |

**Shape B (pass-through) agencies have no sweep** — funds went direct. They still get a scroll, because the government still needs the itemised, head-wise classification of money that arrived in its account. This is exactly why the scroll and the sweep must be separate features: the scroll is *information*, the sweep is *money*, and agencies buy the information.

### 13.5 Scroll generation

The scroll is the artefact the government actually reconciles against, and getting it right is disproportionately valuable in a demo because it is the deliverable the agency's accountant recognises immediately.

**Header:** agency code and legal name, collecting institution, business date, scroll sequence, format version, control total, record count, generation timestamp, digital signature.

**Detail line — one per allocation, not per payment.** This is the crucial modelling point: the treasury books by revenue head, and one payment may span four heads, so the scroll must be at allocation granularity or it cannot be classified.

| Field | Example — line 1 of `demo-data/scroll_fbr_20260730.csv`, verbatim |
|---|---|
| Line no | `000001` |
| Revenue head code | `B01102` (Income Tax on Individuals & AOPs) |
| Sub-head / object | `02` |
| PSID | `12010200004676828` |
| Payer name | `SANA TARIQ` |
| Payer tax ID (masked) | `CNIC ****97-8` |
| Tax period | `2025-26` |
| Amount | `119000.00` |
| Payment reference | `P2600011` |
| Receipt / CPR no | `FBR20260730000120037` |
| Channel | `CARD` |
| Rail | `PAYPAK` |
| Value date | `2026-07-30` |
| Instrument type / no | *(blank — electronic payment; carries e.g. `CHEQUE` / `004821` on instrument-funded lines)* |
| Collecting branch | *(blank for electronic; `HBL-0142` on instrument-funded and OTC lines)* |

**Trailer:** record count, sum by revenue head, grand total, SHA-256 of the detail block.

**Hard rules:**

1. `Σ detail amounts = header control total = Σ journal credits to 2010 for that agency and date`. Assert before transmission and refuse to emit a scroll that fails.
2. Scrolls are **immutable once transmitted**. Corrections are supplementary scrolls with a reference to the original — never an edited resend.
3. Emit in whatever format the treasury requires (fixed-width, CSV, XML) — the *content* is stable, only the serialiser varies. Keep the serialiser a plugin per agency.
4. Digitally sign. `[A]` Pakistan's Electronic Transactions Ordinance 2002 provides the general legal basis for electronic records and signatures; **confirm the specific evidentiary requirements with the agency and counsel.**
5. Retain scrolls per the agency's record-retention rule (`[A]` commonly 7–10 years for tax records; confirm).

### 13.6 Period close

| Step | Control |
|---|---|
| 1. Pre-close checks | All five §10.8 controls pass; no `CRITICAL`/`HIGH` breaks open; no `UNCERTAIN` payments; every cycle `SETTLED`; suspense accounts (`1900`) zero |
| 2. Freeze | Block new postings with `value_date` in the period |
| 3. Generate statements | Per agency: opening, collections by head, refunds, fees, sweeps, closing |
| 4. Agency sign-off | Agency confirms; recorded with user, timestamp, and IP |
| 5. Close | `period.status = CLOSED`; ledger rejects any entry dated into it |
| 6. Post-close adjustments | Posted to the **current** period with `relates_to_period` set. Never reopen a closed period. Reopening is the single most abused control in financial systems, so make it impossible rather than merely discouraged. |

Fiscal-year close additionally: revenue-head rollover, PSID sequence reset per scheme (if the scheme embeds a year), archive, and a fiscal-year certificate per agency.

---

## 14. Exceptions: Reversals, Refunds, Returns, Disputes, Dishonour

### 14.1 Refund

| Aspect | Rule |
|---|---|
| Grounds | Over-payment, duplicate, cancelled service, assessment amended downward, erroneous payment, forfeited-deposit release, court order |
| Authority | **The agency owns the refund decision** for revenue already swept; the platform can refund only from funds it still holds. Model both: `refund.funding_source = PLATFORM_HELD \| AGENCY_FUNDED`. This distinction is a common source of commercial dispute — settle it in the design. |
| Beneficiary | **Defaults to the original debit account.** Any change requires an approved override with documented reason — this is the primary refund-fraud vector in every payment platform. |
| Approval | Always maker-checker; tiered limits |
| Partial | Supported; multiple refunds against one payment, capped at `gross − already_refunded` |
| Method | Same rail where possible; RTGS for large; cheque only where no account is known |
| Timing | `[A]` target T+2 business days for platform-held; agency-funded per agency SLA |
| Ledger | T19 then T20 |
| Reversal of allocation | A refund of an allocated payment must reverse the allocation, restoring the assessment balance — unless the refund is of *surplus only*, in which case allocations are untouched. Two distinct paths; implement both and test both. |
| Receipt | Original receipt marked `REFUNDED` (partially or fully) and a credit note issued. Never delete the original receipt — a third party may hold a copy. |

### 14.2 Assessment amended downward after payment

A genuinely awkward case worth specifying because agencies do it constantly (appeal succeeds, rectification order).

1. Agency amends the assessment to a lower amount → new version.
2. `allocated > payable` now. Do **not** delete allocations.
3. Compute surplus = `allocated − payable`.
4. Post T13: Dr `2010` Agency Payable / Cr `2030` Overpayment Payable for the surplus.
5. Per product `overpay_treatment`: auto-refund, credit-on-account, or hold for the payer to elect.
6. Notify payer with a clear explanation, and reissue the receipt as a revised receipt referencing the original.

### 14.3 Reversal

| Initiator | Window | Approval | Notes |
|---|---|---|---|
| Teller (keying error) | Same till, same business date, before till close | Supervisor | Cash returned to the payer physically |
| Switch (timeout) | Per aggregator, typically same day `[A]` | None (system) | Must handle reversal-without-original |
| Rail (return, `pacs.004`) | Per scheme | None | Funds actually go back |
| Ops (misapplication) | Any time before period close | Maker-checker | Prefer *reallocation* to reversal — reversing a payment the payer legitimately made is confusing and generates support load; move the money to the right bill instead |

Reversal cascade — execute in this order and make it a single transaction:

```
reverse_payment(payment):
    1. reverse every APPLIED allocation (status → REVERSED, reason recorded)
    2. recompute assessment + line-item balances; transition statuses back
    3. re-close any released service_gate_token
    4. void the receipt (status VOIDED, reason, timestamp) — do not delete
    5. post the contra journal entry (T21), referencing the original entry
    6. if the payment was in a SETTLED batch, raise a settlement adjustment for the next cycle
    7. if already swept, create a recovery item against the agency (money is with the government)
    8. notify payer and agency
    9. emit payment.reversed
```

Step 7 is the one people forget: once money has been swept to the treasury, the platform cannot reverse it out. It becomes a receivable from the agency, and it must appear as one on the balance sheet.

### 14.4 Recall and cancellation requests

Payer's bank asks for a payment back (`camt.056`), typically a misdirected payment or APP fraud.

1. Receive the request; create a `recall_request`; **do not automatically return the funds.**
2. Check status: swept? allocated? assessment settled?
3. If unallocated and unswept → return, respond `camt.029` accepted.
4. If allocated but unswept → agency decision required (this is government revenue). Notify the agency with an SLA.
5. If swept → respond `camt.029` rejected with reason "funds transferred to beneficiary"; refer to the agency's refund process.
6. Log everything: recall handling is examined in fraud investigations and by the regulator.

### 14.5 Duplicate detection

Run at capture, before allocation. Three tiers:

| Tier | Rule | Action |
|---|---|---|
| Hard | Same `(rail, rail_e2e_id)` or same `(acquirer, STAN, RRN, date)` | Reject as a duplicate; return the original's response. Not a payment at all. |
| Probable | Same `(assessment_id, gross_amount, payer_account_masked)` within `[A]` 10 minutes | Accept the money, flag `probable_duplicate`, do not allocate the second, auto-create a refund in `PENDING_APPROVAL`, notify the payer immediately |
| Possible | Same assessment fully settled and another payment of the same amount arrives within `[A]` 24 h | Accept, hold as unapplied, raise a break, notify the payer |

**Always accept the money and refund it. Never reject a credit that has already left the payer's account** — rejecting creates an unapplied receipt at the *sender's* bank, which is far harder to resolve than a refund from the platform.

This is also where the `ALREADY_SETTLED` resolution response (§8.2) earns its keep: returning the existing receipt at resolution time prevents most duplicates before any money moves.

### 14.6 Cheque dishonour cascade

The most complete exception chain, and the best single demo of the platform's control.

```
Cheque PKR 2,500,000 lodged, provisional credit given, linked to 3 tax challans
   │
   ├─ Day 0  LODGED         → T06 journal; 3 provisional allocations; 3 receipts (marked PROVISIONAL)
   ├─ Day 0  IN_CLEARING    → T07
   ├─ Day 2  RETURNED (INSUFFICIENT_FUNDS)
   │            │
   │            ├─ T10 contra journal
   │            ├─ reverse all 3 allocations (reason CHEQUE_RETURNED)
   │            ├─ 3 assessments: SETTLED → ISSUED/OVERDUE; balances restored
   │            ├─ surcharge accrual RESUMES from the original due date, not from today
   │            │     ← the correct and legally defensible behaviour: the obligation
   │            │       was never discharged, so no surcharge holiday is earned
   │            ├─ 3 receipts VOIDED with reason
   │            ├─ service_gate_token re-closed; agency notified to withdraw the service
   │            ├─ dishonour charge assessment created (new PSID, product DISHONOUR-CHG)
   │            ├─ payer notified: SMS + email + letter, with the return reason
   │            ├─ payer risk flag raised; cheque acceptance may be blocked for this payer
   │            └─ if the money was already swept → recovery item against the agency (§14.3 step 7)
   │
   └─ Optional: re-presentment once, if the return reason is re-presentable
```

### 14.7 Dispute and chargeback

Card-funded payments only (other rails have no chargeback). Model: `dispute` with scheme reason code, evidence bundle (receipt, resolution trace, assessment, IP and device of the intent, `application_trace`), representment deadline, and outcome. **The strongest representment evidence in a P2G context is the resolution trace plus the delivered government service** — the payer received a licence, a cleared consignment, or a stamped instrument. Assemble that bundle automatically; it wins most representments.

Liability allocation must be configured per agency: operator-absorbed, agency-absorbed, or shared. Whatever the choice, the agency must see it in its statement.

---

## 15. Agency Onboarding, Product Configuration, and Commercials

### 15.1 Onboarding workflow

| Stage | Deliverable | Control |
|---|---|---|
| 1. Agency registration | Legal entity, authorised signatories, treasury accounts | KYB-equivalent due diligence; board resolution or government notification |
| 2. Legal | Service agreement, SLA, liability, data-processing terms, refund authority | Legal sign-off |
| 3. Revenue head mapping | The agency's Chart of Accounts loaded and mapped | **Agency finance must sign off the head mapping. A wrong head means the treasury books revenue in the wrong place, which is worse than not collecting it.** |
| 4. Product definition | Each collection product configured (§6.3) | Maker-checker; effective-dated |
| 5. Reference scheme | Existing scheme registered, or a platform PSID scheme allocated | Checksum verified against a sample of at least 100 live references |
| 6. Channel enablement | Which channels, which limits, which fees | Per-channel certification where an aggregator is involved |
| 7. Integration | API credentials, mTLS certificates, webhook endpoints, IP allowlist | Sandbox certification suite passed |
| 8. UAT | The agency runs the §26 scenario pack in sandbox | Signed UAT report |
| 9. Pilot | Limited volume/branches, with daily reconciliation review | Exit criteria: 3 consecutive clean recon days |
| 10. Go-live | Progressive rollout | Hypercare with daily standing calls |

Target: **an agency with an existing reference scheme goes live in ≤ 10 business days, with no platform code change.** State this target in the design; it is the commercial claim the architecture exists to support, and reviewers will test whether the configuration model is actually rich enough to back it.

### 15.2 Self-service product configuration

The agency portal must let an `AGENCY_ADMIN` create a product, with maker-checker, without engineering. Fields exactly as §6.3, presented as a guided flow: identity → reference scheme → amount rules → channels → fees → revenue heads → receipt template → limits → review and submit for approval. Show a **live preview**: a generated sample PSID, a rendered challan PDF, a rendered QR, and a simulated resolution response. Nothing sells a configuration model faster than watching a new tax product become payable in ninety seconds.

### 15.3 Revenue head mapping

| Field | Notes |
|---|---|
| `revenue_head.code` | The government's own COA code, e.g. `B02341` |
| `fund` | Federal Consolidated Fund / Provincial CF / Public Account `[A]` |
| `object_class` | Tax / non-tax receipt / deposit |
| `effective_from` / `effective_to` | **Heads change between fiscal years.** A payment for tax year 2024-25 posted in 2026 must use the head valid for the *period*, not for today. |
| `is_refundable_deposit` | Routes to `2040` rather than `2010` |
| `mapping_rule` | How a product's line types map to heads: `{PRINCIPAL: B02341, SURCHARGE: B02388, PENALTY: B02391}` |

### 15.4 Derived amount rules (surcharge, discount, rounding)

Configured as declarative JSON on the product; evaluated at resolution time and stored on the intent so the payer's quote is provable.

```json
{
  "surcharge_rule": {
    "basis": "DAILY_SIMPLE",
    "rate_pct_per_annum": 12.0,
    "accrues_on": "PRINCIPAL_ONLY",
    "grace_days": 0,
    "start_from": "DUE_DATE",
    "compounding": "NONE",
    "max_pct_of_principal": 100.0,
    "day_count": "ACT_365",
    "round_to_minor": 100
  },
  "early_discount_rule": {
    "basis": "PCT_OF_PRINCIPAL",
    "value_pct": 25.0,
    "valid_until": {"type": "DAYS_FROM_ISSUE", "days": 10},
    "applies_to_line_types": ["PRINCIPAL"]
  },
  "rounding_rule": "NEAREST_1",
  "escalation_schedule": [
    {"after_days": 30, "add_pct_of_principal": 50.0, "line_type": "PENALTY"},
    {"after_days": 90, "add_pct_of_principal": 100.0, "line_type": "PENALTY"}
  ]
}
```

Requirements:

- **Deterministic and reproducible.** `compute_derived(assessment, as_of_date, rule_version)` must return identical results for the same inputs forever. Version the rules and store `rule_version` on the intent and the payment.
- **Never mutate the assessed principal.** Surcharge and penalty are separate line items on separate revenue heads.
- **Recompute on every read**, then store the computed figure on the intent when a payer commits to a quote. A payer must never be surcharged for time that elapsed while they were on the payment screen.
- **Cap and floor.** Always bound accrual; an uncapped daily surcharge on a forgotten PKR 200 challan eventually produces an absurd number and a newspaper story.

### 15.5 Fees, MDR, and tax on fees

| Concept | Model |
|---|---|
| `fee_schedule` | Per product × channel × amount tier |
| `basis` | `FLAT \| PCT \| GREATER_OF(flat,pct) \| LESSER_OF \| TIERED` |
| `fee_bearer` | `PAYER` (added on top — the payer's debit exceeds the payable), `AGENCY` (deducted from settlement), `SPLIT` (both) |
| `tax_on_fee` | `[A]` Provincial sales tax on services may apply to the platform's fee. Model rate by jurisdiction, compute, and hold in `2200`. |
| Channel commission | What the platform pays out to the collecting bank/agent, per channel; expense `5020`, liability `2100` |
| Interchange-like flows | For card, MDR splits between acquirer, scheme, issuer — model as a settlement deduction with a breakdown |
| Disclosure | **The payer MUST see the fee before authorising.** Non-negotiable, everywhere, in every channel. Show it in the resolution response so no channel can omit it. |
| Zero-fee mandate | `[V]` SBP aimed to make Raast services free to end users in early phases and Raast is designed on cost recovery. Design for `fee = 0` as a first-class, fully-tested case: no division by zero, no empty fee line on the receipt, no "PKR 0.00 fee" row cluttering the challan. |

### 15.6 Refundable deposits — a different animal

Tender security, earnest money, and court security deposits are **not revenue**. They are liabilities of the government to the payer.

| Difference | Handling |
|---|---|
| Ledger | Cr `2040` Refundable Deposits, never `2010` Agency Payable |
| Government accounting | Public Account, not Consolidated Fund `[A]` — confirm classification |
| Lifecycle | `RECEIVED → HELD → (REFUNDED \| FORFEITED \| CONVERTED_TO_REVENUE)` |
| Expectation | A refund is the *normal* outcome, not an exception. Build the refund path as the happy path. |
| Interest | `[A]` Some deposits accrue interest payable to the depositor. Model an accrual rule; default off. |
| Ageing | Unclaimed deposits need an ageing and escheatment policy |
| Scroll | Reported separately from revenue; do not mix into the revenue scroll |

---

## 16. Receipting, Evidence, and Verification

### 16.1 The receipt is the product, for the payer

For a citizen, the platform's entire value is the receipt. `[A]` In Pakistan the tax-payment receipt artefact is the **Computerized Payment Receipt (CPR)**, used as proof in filings; confirm its required content and issuing authority per §27.2 Q12. Model a generic `receipt` with an agency-specific template so a CPR is one rendering among several.

| Requirement | Detail |
|---|---|
| Issue latency | p99 ≤ 3 s from payment confirmation. This is what makes a payer trust the platform. |
| Numbering | Gapless per agency per day; `{AGENCY}{YYYYMMDD}{9-digit seq}`; **gaps are an audit finding**, so allocate from a database sequence, never from a counter in application memory |
| Content | Agency name and logo; receipt no; payment reference; PSID; payer name and masked ID; head-wise breakdown; amount in figures **and words**; fee shown separately; channel; rail; value date; obligation discharge date; teller/branch where applicable; instrument details; QR verify code; "This is a system-generated receipt" |
| Provisional marking | A receipt for an uncleared cheque **must** be visibly marked `PROVISIONAL — subject to realisation of instrument`. Printing an unqualified receipt against an uncleared cheque is how platforms get sued. |
| Immutability | Never edit. Void and reissue, both retained and cross-referenced. |
| Signature | Detached digital signature over a canonical JSON of the receipt fields; publish the verification key |
| Formats | PDF/A-3 (with the signed JSON embedded as an attachment), HTML, and a JSON API representation |
| Languages | English and Urdu; RTL-correct rendering for Urdu |
| Retention | `[A]` 7–10 years for tax receipts; confirm per agency |

### 16.2 Third-party verification

`GET /verify/{verify_code}` — public, unauthenticated, rate-limited. Returns a minimal, privacy-safe confirmation: agency, receipt number, amount, date, status (`VALID | VOIDED | REFUNDED`), and a masked payer name. **No PII beyond a masked name, ever** — this endpoint is public and will be scraped.

Offline verification: the receipt QR contains the signed JSON payload (compressed) so a verifier with the public key can validate authenticity **with no network access**. This matters for a rural licensing office with no connectivity, and it is a genuinely impressive 20-second demo: print a receipt, disconnect the network, scan it, watch it verify. Then alter one digit and watch it fail.

### 16.3 Notifications

| Event | Channels | Content rules |
|---|---|---|
| Assessment issued | SMS, email, push, in-app | PSID, amount, due date, how to pay |
| RtP received | Push (payer's bank app), SMS fallback | Agency, purpose, amount, expiry, accept/decline |
| Reminder before due date | SMS, email | `[A]` T−7, T−1; configurable; respect quiet hours |
| Payment confirmed | SMS + email with receipt attached | Receipt no, amount, what it settled, **and what remains open** |
| Partial payment | SMS + email | Explicitly state the remaining balance and the new due date |
| Payment failed | SMS | Plain-language reason and a retry path |
| Cheque returned | SMS + email + letter | Return reason, restored balance, dishonour charge, how to remedy |
| Refund initiated / completed | SMS + email | Amount, beneficiary account masked, expected date |
| Mandate pre-notification | SMS + email | `[A]` N days before debit; mandatory |
| Overdue escalation | SMS, email, letter | Escalating; must be capped and logged |

Rules: never put a full CNIC/NTN or a full account number in an SMS. Respect quiet hours (`[A]` 21:00–08:00 Asia/Karachi). Cap total messages per payer per assessment (`[A]` 6). Every send is logged with template version and delivery status, because "I was never told" is the most common citizen complaint and the log is the answer.

---

## 17. API Design

Full machine-readable contract in `api/openapi.yaml`. This section specifies the cross-cutting behaviour the OpenAPI file cannot express.

### 17.1 API surfaces

| Surface | Base path | Consumers | Auth |
|---|---|---|---|
| **Channel API** | `/v1/` | Banks, EMIs, PSPs, aggregators | mTLS + OAuth2 client credentials + request signing |
| **Agency API** | `/v1/agency/` | Agency assessment systems | mTLS + OAuth2 + IP allowlist |
| **Biller/Switch API** | `/switch/v1/` | 1LINK-style aggregators, four-message contract | mTLS + scheme-specific auth |
| **Back-office API** | `/admin/v1/` | Platform and agency users via the portal | OIDC + RBAC + step-up for financial actions |
| **Public API** | `/public/v1/` | Receipt verification only | None; rate-limited |
| **Internal API** | `/internal/` | Control reports, replay, rebuild | Network-isolated; break-glass audited |

### 17.2 Authentication and message security

| Layer | Requirement |
|---|---|
| Transport | TLS 1.3 minimum; **mutual TLS for all server-to-server**; certificate pinning for aggregators |
| Client auth | OAuth 2.0 client credentials, short-lived tokens (`[A]` 15 min), scoped per surface and per institution |
| Request signing | Detached **JWS** over `(method, path, body SHA-256, timestamp, nonce)` in an `X-Signature` header. Protects against a compromised TLS terminator and gives non-repudiation. |
| Replay protection | `X-Timestamp` within ±60 s plus a nonce cache; reject duplicates |
| Authorisation | Scopes: `resolve:read`, `payments:write`, `assessments:write`, `rtp:write`, `refunds:write`, `admin:*`. Every request also checked against the institution's own data boundary. |
| Multi-tenancy | Agency isolation enforced at the **data layer** (row-level security keyed to the token's tenant), not only in application code. Add a test that proves agency A cannot read agency B's assessment even with a valid PSID. |

### 17.3 Standard headers

| Header | Direction | Purpose |
|---|---|---|
| `Idempotency-Key` | In | Required on every POST/PATCH/DELETE that changes money or state |
| `X-Correlation-Id` | In/Out | UUIDv7; echoed; on every log line |
| `X-Institution-Id` | In | Calling institution |
| `X-Timestamp`, `X-Nonce`, `X-Signature` | In | Message security |
| `X-Api-Version` | In | Explicit version pin |
| `X-Request-Trace` | Out | Server-side trace id for support |
| `Retry-After` | Out | On 429/503 |
| `X-RateLimit-*` | Out | Limit, remaining, reset |

### 17.4 Idempotency — exact semantics

```
On a state-changing request with Idempotency-Key K on endpoint E for institution I:

1. fingerprint = SHA256(canonical(body))
2. Look up (I, E, K) in idempotency_record
3. Not found  → INSERT with state=IN_PROGRESS, fingerprint    [unique constraint = the lock]
                 → process → UPDATE with state=COMPLETE, response_status, response_body
                 → return the response
4. Found, COMPLETE, same fingerprint  → return the STORED status and body verbatim.
                                        Do NOT reprocess. Add header X-Idempotent-Replay: true
5. Found, COMPLETE, different fingerprint → 422 IDEMPOTENCY_KEY_REUSED
                                             ("same key, different payload")
6. Found, IN_PROGRESS → 409 REQUEST_IN_PROGRESS with Retry-After: 2
7. Records retained 7 days (configurable), then purged
```

The unique constraint on `(institution_id, endpoint, idempotency_key)` **is** the concurrency control. Do not add an application-level mutex; the database is already correct and a second lock introduces a second failure mode.

### 17.5 Error model

```json
{
  "type": "https://errors.nexuscollect.example/PAYABLE_EXPIRED",
  "title": "Payable expired",
  "status": 409,
  "code": "PAYABLE_EXPIRED",
  "detail": "PSID 41011300000190123 expired on 2026-07-15.",
  "instance": "/v1/payment-intents",
  "correlation_id": "0190f3c2-...",
  "payer_message": "This bill expired on 15 July 2026. Please generate a new one.",
  "payer_message_ur": "یہ بل 15 جولائی 2026 کو ختم ہو گیا۔ براہ کرم نیا بل بنائیں۔",
  "retryable": false,
  "errors": [{"field": "psid", "code": "EXPIRED", "message": "..."}]
}
```

RFC 9457 Problem Details, plus four additions that matter operationally: a stable machine `code`, a **payer-facing message the channel can display verbatim** (so twenty banks do not each invent their own wording for the same condition), its Urdu translation, and an explicit `retryable` flag so clients never have to guess whether to retry.

### 17.6 Error catalogue (extract — full list in OpenAPI)

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `INVALID_REFERENCE_FORMAT` | 400 | No | Wrong length/charset |
| `INVALID_REFERENCE_CHECKSUM` | 400 | No | Check digit failed |
| `REFERENCE_NOT_FOUND` | 404 | No | No such payable |
| `MULTIPLE_PAYABLES` | 200 | — | List returned; not an error |
| `PAYABLE_EXPIRED` | 409 | No | Past expiry |
| `ALREADY_SETTLED` | 409 | No | Includes the existing receipt |
| `PARTIAL_NOT_ALLOWED` | 422 | No | Product forbids partial |
| `AMOUNT_BELOW_MINIMUM` / `AMOUNT_ABOVE_MAXIMUM` | 422 | No | |
| `CHANNEL_NOT_ELIGIBLE` | 403 | No | |
| `LIMIT_EXCEEDED` | 429 | No | Includes which limit and its reset |
| `RESOLUTION_TOKEN_EXPIRED` | 409 | No | Re-resolve |
| `RESOLUTION_TOKEN_INVALID` | 401 | No | Signature/binding failed |
| `AMOUNT_CHANGED` | 409 | No | Surcharge accrued; new amount returned |
| `IDEMPOTENCY_KEY_REUSED` | 422 | No | Same key, different body |
| `REQUEST_IN_PROGRESS` | 409 | Yes | Retry after the given interval |
| `DUPLICATE_PAYMENT` | 409 | No | Returns the original |
| `ALIAS_NOT_FOUND` / `ALIAS_EXPIRED` | 404 / 409 | No | `[V]` Raast IDs can expire |
| `RTP_NOT_MODIFIABLE` | 422 | No | `amount_modifiable=false` |
| `AGENCY_UNAVAILABLE` | 503 | Yes | Circuit breaker open |
| `PAYMENT_UNCERTAIN` | 202 | — | Internal state; **never returned to a switch** |
| `INSUFFICIENT_APPROVAL` | 403 | No | Maker-checker not complete |
| `PERIOD_CLOSED` | 409 | No | Cannot post into a closed period |

### 17.7 Endpoint inventory

| Method & path | Purpose | Idem. |
|---|---|---|
| `POST /v1/resolve` | Reference/attribute → payables | n/a (read) |
| `POST /v1/payment-intents` | Create a quote | Yes |
| `GET /v1/payment-intents/{id}` | Status | |
| `POST /v1/payment-intents/{ref}/cancel` | Abandon | Yes |
| `POST /v1/payments` | Confirm a captured payment | **Yes** |
| `GET /v1/payments/{id}` / `?intent_reference=` | Status | |
| `POST /v1/payments/{id}/reverse` | Reverse | Yes |
| `GET /v1/payments/{id}/receipt` | Receipt (JSON/PDF) | |
| `POST /v1/requests-to-pay` | Create an RtP | Yes |
| `GET /v1/requests-to-pay/{id}` | Status | |
| `POST /v1/requests-to-pay/{id}/cancel` | Cancel | Yes |
| `POST /v1/requests-to-pay/{id}/remind` | Reminder | Yes |
| `POST /v1/requests-to-pay/bulk` | Bulk campaign | Yes |
| `POST /v1/instruments` | Lodge a cheque/PO/DD, with linking | Yes |
| `POST /v1/instruments/{id}/present` / `/clear` / `/return` | Clearing lifecycle | Yes |
| `POST /v1/bulk-payments` / `/{id}/confirm` | Bulk file | Yes |
| `POST /v1/mandates` / `DELETE /v1/mandates/{id}` | Mandate lifecycle | Yes |
| `POST /v1/checkout-sessions` | Hosted checkout | Yes |
| `POST /v1/agency/assessments` | Create/push an assessment | Yes |
| `PATCH /v1/agency/assessments/{id}` | Amend (new version) | Yes |
| `POST /v1/agency/assessments/{id}/cancel` | Cancel | Yes |
| `POST /v1/agency/assessments/bulk` | Bulk intake | Yes |
| `GET /v1/agency/assessments` | Search | |
| `GET /v1/agency/settlements` | Settlement batches | |
| `GET /v1/agency/settlements/{id}/scroll` | Download the treasury scroll | |
| `GET /v1/agency/assessments/{psid}` | Read one assessment | |
| `GET /v1/agency/assessments/{psid}/status` | **Synchronous service-gate check** (p99 200 ms) | |
| `GET /v1/agency/statements` | Period statement | |
| `POST /v1/agency/refunds` | Agency-initiated refund | Yes |
| `POST /switch/v1/bill-inquiry` | Aggregator inquiry | n/a |
| `POST /switch/v1/bill-payment` | Aggregator payment | **Yes (STAN/RRN)** |
| `POST /switch/v1/bill-payment-reversal` | Aggregator reversal | Yes |
| `POST /switch/v1/bill-payment-advice` | Late advice | Yes |
| `POST /admin/v1/recon/runs` | Trigger recon | Yes |
| `GET /admin/v1/recon/runs/{id}` | Run status, control totals, auto-match rate |  |
| `GET /admin/v1/recon/runs/{id}/breaks` | Break register |  |
| `POST /admin/v1/recon/breaks/{id}/propose` / `/approve` | Maker-checker | Yes |
| `POST /admin/v1/settlements/{id}/sweep` | Sweep instruction | Yes |
| `GET /admin/v1/reports/{code}` | MIS |  |
| `GET /public/v1/verify/{code}` | Receipt verification |  |
| `GET /internal/control/trial-balance` | §10.8 assertion 1 |  |
| `GET /internal/control/allocation-integrity` | §10.8 assertion 2 |  |
| `POST /internal/control/balance-rebuild` | §10.8 assertion 3 | Yes |
| `GET /internal/control/ledger-vs-subledger` | §10.8 assertion 4 |  |
| `GET /internal/ledger/verify-chain` | §10.8 assertion 5 |  |

### 17.8 Pagination, filtering, versioning

- **Cursor pagination** everywhere: `?limit=50&cursor=...`, response `{data:[], next_cursor, has_more}`. Never offset pagination on payment or ledger collections — offsets skip and duplicate rows under concurrent inserts, which in a financial report is a correctness bug, not a cosmetic one.
- Filters: `value_date_from/to`, `status`, `channel`, `rail`, `agency_id`, `product_id`, `amount_min/max`, `q`.
- Versioning: URL major version plus an `X-Api-Version` date pin for minor changes. Additive changes only within a major. Breaking changes get a new major with `[A]` 12 months of parallel running.
- Sorting: default `created_at DESC`; allow `value_date`, `amount`.
- **Exports** over 10,000 rows are async: `POST /admin/v1/exports` → job → signed download URL, with the file hashed and the hash logged.

---

## 18. Events, Webhooks, and Integration

### 18.1 Event catalogue

Emitted via a **transactional outbox** (write the event in the same database transaction as the state change; a relay publishes it). Never publish from application code before the transaction commits — that is how you send a `payment.confirmed` webhook for a payment that then rolls back.

| Event | Payload highlights | Subscribers |
|---|---|---|
| `assessment.created` / `.amended` / `.cancelled` / `.expired` | psid, amounts, version | Agency, notifications |
| `assessment.settled` / `.partially_paid` / `.unsettled` | balance, allocations | **Agency (service gating)**, notifications |
| `payable.resolved` | key type, institution, outcome | Analytics, fraud |
| `intent.created` / `.expired` | | Analytics |
| `payment.confirmed` | reference, amount, allocations, receipt no | **Agency**, notifications, recon |
| `payment.uncertain` / `.resolved` | | Ops alerting |
| `payment.reversed` / `.refunded` | reason, contra entry | Agency, notifications |
| `payment.duplicate_detected` | original reference | Ops, notifications |
| `rtp.created` / `.delivered` / `.accepted` / `.declined` / `.expired` / `.fulfilled` | | Agency, notifications |
| `instrument.lodged` / `.cleared` / `.returned` | return reason | Agency, notifications |
| `allocation.applied` / `.reversed` | head-level detail | Agency sub-ledger sync |
| `settlement.cycle_settled` / `batch.swept` | net, references | Agency, treasury |
| `scroll.generated` / `.acknowledged` / `.rejected` | control totals | Agency, ops |
| `recon.run_completed` | match rate, break count | Ops, agency |
| `recon.break_opened` / `.resolved` | code, amount, age | Ops |
| `refund.approved` / `.completed` | | Notifications |
| `receipt.issued` / `.voided` | | Notifications |
| `limit.breached` / `fraud.flagged` | | Risk |
| `control.assertion_failed` | which control | **Page immediately** |

### 18.2 Webhook delivery contract

| Aspect | Rule |
|---|---|
| Signature | `X-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>`; publish a verification snippet in the integration guide |
| Retries | Exponential backoff: 0s, 30s, 2m, 10m, 1h, 6h, 24h — then dead-letter |
| Ordering | **Not guaranteed.** Every event carries `sequence` per aggregate; consumers must handle out-of-order and are told so explicitly |
| At-least-once | Duplicates will happen. Every event has a stable `event_id` for consumer-side dedup. |
| Timeout | 5 s; a non-2xx or a timeout is a retry |
| Replay | `POST /admin/v1/webhooks/{id}/replay?from=&to=` for consumer recovery |
| Secret rotation | Two active secrets during rotation; sign with both |
| Circuit breaker | Suspend a consistently failing endpoint after `[A]` 100 consecutive failures and alert the subscriber |

### 18.3 Agency integration patterns

| Pattern | When | Mechanism |
|---|---|---|
| **Push assessments** | Agency knows liabilities in advance (tax demands, challans) | `POST /v1/agency/assessments` |
| **On-demand assessment** | Liability computed at payment time (a fee for a service being applied for) | Platform calls the agency's `POST {agency}/quote` at resolution — needs a **circuit breaker plus a cached fallback**, or the agency's downtime becomes the platform's downtime |
| **Sub-ledger sync** | Agency maintains its own receivables | `allocation.applied` events + a nightly reconciliation file |
| **File-based** | Legacy agencies with no API | SFTP drop; scheduled ingest; a per-file control record. Do not treat this as second-class — it will be a large share of real volume. |
| **Service gating** | Payment releases a service | `assessment.settled` webhook + a synchronous `GET /v1/assessments/{psid}/status` the agency can poll before releasing. **Provide both**; the agency will want to double-check before releasing a container. |
---

## 19. Non-Functional Requirements

### 19.1 Availability and resilience

| Requirement | Target | Notes |
|---|---|---|
| Core collection path availability | 99.95% monthly (≈22 min/month) | `[A]` Confirm against SBP expectations for a PSO; national payment infrastructure is often held to higher |
| Back-office availability | 99.5% business hours | |
| RPO | **0** for committed payments | Synchronous replication for the ledger. A payment that returned success must survive the loss of a datacentre. |
| RTO | ≤ 15 min for the collection path; ≤ 4 h for back-office | |
| DR posture | Active-passive across two sites, with a documented, **rehearsed** failover | An untested DR plan is a document, not a capability. Rehearse quarterly and record the result. |
| Degraded mode | If the ledger is unavailable, **stop accepting payments.** Do not accept money you cannot record. | State this explicitly; the temptation to queue-and-hope is strong and always wrong |
| Agency downtime | Circuit breaker + cached last-known payable + `AGENCY_UNAVAILABLE`. Never let an agency outage look like a platform outage to the payer, and never guess an amount. | |
| Rail downtime | Fail over to alternate rails where the product allows (Raast → IBFT → OTC); surface honestly in the channel | |

### 19.2 Latency budgets (p99, server-side)

| Operation | Budget | Why |
|---|---|---|
| `POST /v1/resolve` | **300 ms** | Sits inside an ATM/switch timeout; every channel calls it first |
| `POST /switch/v1/bill-inquiry` | **300 ms** | Aggregator timeouts are unforgiving |
| `POST /v1/payment-intents` | 500 ms | |
| `POST /v1/payments` (confirm + allocate + post + receipt) | **800 ms** | The whole apply pipeline. Achieve it by making receipt *rendering* async while receipt *numbering* is synchronous. |
| `POST /switch/v1/bill-payment` | **800 ms** | |
| Receipt PDF availability | 3 s | Async render; the number and JSON exist immediately |
| Webhook first attempt | 5 s from event | |
| Service-gate status query | **200 ms** | Customs release depends on it |
| Recon run, 1M records | 10 min | |
| Scroll generation, 500k lines | 5 min | |

**Design note:** to hit 800 ms on the apply pipeline, do inside the transaction only what must be durable and consistent — payment row, allocations, journal entry, receipt number, outbox events. Everything else (PDF rendering, SMS, email, webhook dispatch, analytics) happens off the outbox, after commit. This is the whole trick, and it also gives you replay for free.

### 19.3 Throughput and peak-day planning

Tax deadlines create the sharpest, most predictable load spike in financial services. `[A]` Size to these figures and state them:

| Scenario | Sustained | Peak |
|---|---|---|
| Normal day | 50 TPS | 200 TPS |
| Month-end | 200 TPS | 800 TPS |
| **Tax filing deadline (last 6 hours)** | **1,000 TPS** | **3,000 TPS** |
| Bulk RtP campaign | 5,000 RtP/min | — |
| Resolution calls | 5× payment volume | 10× |

Peak-day playbook — write it down, because on the night it matters nobody will be inventing:

1. Pre-scale before the window; do not rely on autoscaling to react to a step function.
2. Freeze all deploys for 48 hours either side.
3. Move recon, scroll generation, and reporting out of the peak window entirely.
4. Shed load in a defined order: analytics → reports → back-office → bulk → **never the collection path**.
5. Raise per-institution rate limits by prior agreement, not on the night.
6. Pre-warm caches: product config, reference schemes, revenue heads, fee schedules.
7. Read replicas for all resolution traffic; the primary handles writes only.
8. Extend the cut-off if the agency's statutory deadline requires it, and record the decision.
9. Staff the ops bridge; page proactively on queue depth, not just on errors.
10. Expect the surge to be `resolve`-heavy: many citizens check their bill several times before paying.

### 19.4 Limits and velocity controls

Necessary because `[V]` **Raast itself imposes no transaction limits** — participants set them. The platform must therefore be an explicit limit authority.

| Scope | Controls |
|---|---|
| Per transaction | Product min/max; channel max; instrument max |
| Per payer per day | Amount and count, by product and overall |
| Per payer per month | Amount and count |
| Per institution per day | Amount and count (protects against a partner defect) |
| Per agency | Optional collection cap |
| Per teller/till | Cash acceptance limit; till holding limit (physical security) |
| Per agent | Float-based cap |
| Global platform | Circuit breaker on anomalous total volume |

**Precedence:** most restrictive wins. Return `LIMIT_EXCEEDED` naming **which** limit and when it resets — a client that cannot tell the payer "you can pay after midnight" will simply retry in a loop.

### 19.5 Data volume and retention

| Data | Volume assumption `[A]` | Retention | Storage strategy |
|---|---|---|---|
| Payments | 50M/year | 10 years | Partition by `value_date` month; archive > 24 months to cold storage with online metadata |
| Allocations | 120M/year | 10 years | Same partitioning |
| Journal lines | 400M/year | 10 years | Monthly partitions; **never delete** |
| Resolution logs | 500M/year | 13 months | Aggressive partitioning; sampled beyond 90 days |
| Audit log | 100M/year | 10 years | Append-only, hash-chained, WORM storage |
| Receipts (PDF) | 50M/year | 10 years | Object storage; regenerate on demand from signed JSON rather than storing every PDF forever |
| Recon source records | 200M/year | 7 years | Raw files retained separately, hashed |

Retention figures are `[A]` and must be confirmed against the agency's statutory record-keeping rules and SBP requirements.

### 19.6 Observability

| Layer | Requirement |
|---|---|
| Tracing | OpenTelemetry; `correlation_id` spans the channel call, rail call, and every async job |
| Metrics | RED (rate, errors, duration) per endpoint; plus **business metrics**: auto-match rate, unapplied balance, `UNCERTAIN` queue depth, breaks by age, settlement lag, receipt latency |
| Logs | Structured JSON; **PII redacted at the logging library**, not by convention. No PAN, no full CNIC, no full account number, ever, including in error stack traces. |
| The four alerts that matter most | `control.assertion_failed` (any of §10.8) · `UNCERTAIN` depth > 50 or age > 30 min · unapplied balance breaching a threshold · resolution p99 > 300 ms for 5 min |
| Dashboards | Live collections by agency/channel/rail; settlement position; break register; SLO burn |
| Business-day close dashboard | The one screen ops actually watches: cycles settled, sweeps done, scrolls acknowledged, controls green, breaks by age |

---

## 20. Security, Privacy, and Compliance

### 20.1 Regulatory perimeter (Pakistan)

`[A]` **Every item in this table must be verified against the current SBP instrument before a production build.** They are listed because a P2G platform operator will be asked about each; the specific circular numbers, dates, and current versions were **not verified** in preparing this document and must not be quoted as fact.

| Area | What to confirm |
|---|---|
| Licensing | Whether the operator needs a **PSO/PSP** authorisation, an EMI licence, or operates under a sponsor bank; the applicable Rules for Payment System Operators and Payment Service Providers |
| Technology risk | SBP's **Technology Risk Management Framework** — current circular reference, and the specific control domains (governance, change management, resilience, incident reporting, third-party risk) |
| Outsourcing | SBP's framework for risk management in outsourcing, if the platform is operated for a bank |
| Consumer protection | Current SBP instructions on customer grievance handling, turnaround times, and complaint reporting |
| AML/CFT | Applicability of CDD to bill-payment activity; monitoring and STR obligations for a collection agent |
| Data | Data localisation, cross-border transfer restrictions, and any encryption/key-residency requirements |
| Legal basis | **Payment Systems and Electronic Fund Transfers Act 2007** and **Electronic Transactions Ordinance 2002** — the statutory footing for electronic payment finality and for electronic records/signatures on receipts and scrolls |
| Reporting | Periodic PSO/PSP returns; incident and major-outage notification timelines |
| Cards | PCI-DSS applicability and current level, if card acceptance is in scope |
| Incident RCA | The regulator's expected format and timeline for post-incident reporting |

> **Implementing agent:** build a `compliance_control` register table and seed it with these rows in a `TO_VERIFY` state, each with an owner and a due date. Surfacing "here is what we must confirm, and we know it" is far more credible in front of a bank than inventing a circular number. Never fabricate a regulatory citation.

### 20.2 Authentication and authorisation

- Back-office: OIDC SSO, **mandatory MFA**, session timeout `[A]` 15 min idle, step-up re-authentication for any financial action (approving an adjustment, a refund, a sweep).
- Server-to-server: mTLS + OAuth2 + JWS (§17.2).
- RBAC per §3.2, with row-level tenant isolation enforced in the database.
- Privileged access: **break-glass only**, time-boxed, dual-authorised, fully session-recorded, with an automatic post-hoc review ticket.
- No shared accounts, ever. No service account with interactive login.

### 20.3 Fraud and abuse controls

| Threat | Control |
|---|---|
| PSID enumeration | Damm check digit + 4 random digits (§7.2); per-institution and per-IP resolution rate limits; alert on a high ratio of `NOT_FOUND` to `FOUND` per caller — **that ratio is the single best enumeration signal** |
| Reference scraping to harvest names | Progressive masking (§7.5); step-up authentication for identity-keyed lookups |
| Stale-amount replay | `resolution_token` binds amount to payable set with a 5-minute expiry (§8.2) |
| Payment-confirmation forgery | mTLS + JWS; confirmations reconciled against the rail before sweeping — **never sweep on a channel's word alone** |
| Refund redirection | Beneficiary defaults to the original debit account; override needs approval + documented reason |
| Insider misallocation | Maker-checker; hash-chained ledger; allocation-integrity control; alert on any manual allocation |
| Third-party payer abuse | Per-remitter velocity monitoring (§8.14) |
| Money laundering via overpay-and-refund | **Refunds only to the original debit account by default**; monitor overpay-then-refund patterns per payer; this is a classic laundering typology in collection systems and reviewers will ask about it specifically |
| Card testing / BIN attacks | Velocity by BIN and device; 3-D Secure |
| Agent float fraud | Reconcile agent float daily; alert on negative or anomalous drift |
| Teller theft | Till reconciliation at every close; over/short posted to `5900` and always investigated, never netted |

### 20.4 Data protection

| Data | At rest | In transit | In logs | In UI |
|---|---|---|---|---|
| CNIC / NTN / passport | Encrypted (deterministic, to stay searchable) | TLS 1.3 | **Never** | Masked; full value only for authorised roles with an access reason recorded |
| Bank account / IBAN | Encrypted | TLS 1.3 | Masked | Masked (`PK**...**3421`) |
| PAN (card) | **Never stored** | Never touches the platform | Never | BIN6 + last4 only |
| Payer name | Plain (needed for matching) | TLS 1.3 | Masked in public contexts | Per §7.5 |
| Amounts | Plain | TLS 1.3 | Plain | Plain |
| Receipt PDFs | Encrypted object storage; time-limited signed URLs | TLS 1.3 | n/a | Authenticated access only |

Keys in an HSM or a managed KMS; envelope encryption; documented rotation (`[A]` annually for data keys, per policy for master keys); key material never in source, config, or environment variables.

### 20.5 Audit trail

Every state change writes `audit_log`: actor (user or service), action, entity type and id, before/after JSON diff, IP, user agent, correlation id, timestamp, and `hash_prev` for chaining. Immutable, WORM-backed, and independently verifiable. Read access to sensitive data is *also* audited (who looked at whose tax record, and why) — for government data this is frequently a legal requirement and always a political one.

### 20.6 Step-up authentication for identity-keyed resolution

Resolving by CNIC or Raast ID exposes a person's obligations, so it needs more than a keypad entry:

1. Payer enters the CNIC in a bank channel.
2. Platform requires proof that the caller is authenticated as that person: either the channel asserts it (bank customer, CNIC matches the bank's own KYC record — preferred, since the bank has already done the identity work) or an OTP is sent to the MSISDN registered against that identity.
3. Successful step-up mints a scoped, short-lived token permitting full-detail resolution for that identity only.
4. Every identity-keyed resolution is audited with the asserting institution recorded.

---

## 21. Reporting, MIS, and Analytics

### 21.1 Standard report pack

| # | Report | Frequency | Audience | Key content |
|---|---|---|---|---|
| R01 | Daily Collection Summary | Daily | Agency, platform | By product, channel, rail; count, gross, fees, net |
| R02 | **Head-wise Collection Statement** | Daily, monthly | Agency finance, treasury | Revenue head × period × amount; **the report the treasury actually uses** |
| R03 | Daily Reconciliation Certificate | Daily | Agency, audit | Matched, breaks, opening/closing unreconciled, signed |
| R04 | Break Register & Ageing | Daily | Ops | By code, age bucket, owner, amount |
| R05 | Settlement & Sweep Report | Daily | Agency, treasury | Cycles, nets, sweep references, scroll ids, ack status |
| R06 | Unapplied Receipts Ageing | Daily | Ops, compliance | The stranded-money report |
| R07 | Outstanding Assessments Ageing | Weekly | Agency | Arrears by age, product, payer segment — feeds RtP campaigns |
| R08 | RtP Funnel | Weekly | Agency | Sent → delivered → accepted → fulfilled, with decline reasons |
| R09 | Channel Performance | Monthly | Platform, commercial | Volume, value, success rate, latency, cost per transaction by channel |
| R10 | Fee & Revenue Statement | Monthly | Commercial, finance | Fee income, tax on fees, commissions paid, net margin by agency |
| R11 | Refunds & Reversals | Monthly | Agency, audit | By reason code, with ageing and approval trail |
| R12 | Cheque Performance | Monthly | Agency, risk | Lodged, cleared, returned; return rate by drawee bank and by payer |
| R13 | Trial Balance & Control Pack | Daily | Finance, audit | §10.8 assertions, pass/fail |
| R14 | Period Statement per Agency | Monthly | Agency | Opening, collections, refunds, fees, sweeps, closing |
| R15 | SLA & Availability | Monthly | Agency, regulator | Uptime, latency percentiles, incidents |
| R16 | Payer Experience | Monthly | Product | Abandonment by channel and step, duplicate rate, complaint themes |
| R17 | Regulatory Return | As required | Regulator | `[A]` per SBP's PSO/PSP reporting format — confirm |
| R18 | Fiscal Year Certificate | Annual | Agency, AG | Full-year head-wise collection, signed |

### 21.2 Dashboards

**Agency dashboard:** today's collections vs the same day last year; head-wise breakdown; settlement position (confirmed / settled / swept as three distinct numbers); open breaks; outstanding arrears; RtP funnel; top products.

**Ops dashboard:** live TPS; error rate by endpoint; `UNCERTAIN` queue depth and oldest age; break register by age; unapplied balance; cycle status; scroll ack status; the five control assertions as five green ticks.

**Executive dashboard:** collections trend; digital-vs-cash mix over time (**the single best proxy for whether the platform is achieving its policy purpose**); channel mix; cost per transaction; auto-match rate; agency count and time-to-onboard.

### 21.3 Analytics worth building

- **Payment-behaviour segmentation:** who pays early, on time, late, or never — directly drives RtP timing and reminder policy, and is the analysis agencies find most immediately useful.
- **Channel migration:** are OTC cash payers moving to digital? Track cohorts, not aggregates; aggregate mix shifts can be driven entirely by new users while existing payers never change behaviour.
- **Surcharge elasticity:** does an early-payment discount actually accelerate collection, and by how much?
- **Break root-cause Pareto:** which integration causes most breaks. Almost always concentrated in one or two partners; the chart is what gets the partner to fix it.
- **Reference-quality index per channel:** the share of payments arriving with a clean, structured reference. This is the leading indicator of future recon pain and it is measurable from day one.

---

## 22. Back-Office and Operations

### 22.1 Screens to build (minimum viable back office)

| Screen | Function |
|---|---|
| Payment search & 360° view | Search by any reference; timeline of every state change; allocations; journal entries; receipt; recon status; **the `application_trace`** |
| Assessment 360° view | Versions, line items, allocations, payment history, notifications sent |
| Payer 360° view | Accounts, assessments, payments, refunds, risk flags, mandates |
| Unapplied receipts queue | Investigate, search suggestions, propose allocation |
| Break register | Filter, assign, investigate, propose, approve |
| `UNCERTAIN` payments queue | Resolution actions, escalation |
| Instrument register | Cheques by status, clearing calendar, returns |
| Teller / till | Accept payments, print, reverse, close till with over/short |
| Settlement & sweep | Cycle status, sweep authorisation, scroll download and ack |
| Approvals inbox | Everything awaiting a checker, with the journal preview |
| Agency & product configuration | Guided flow with live preview (§15.2) |
| Recon run console | Trigger, monitor, re-run, compare runs |
| Report centre | Run, schedule, export |
| Control assertions | The five §10.8 checks, live |
| Audit explorer | Search the audit log; verify the hash chain |

### 22.2 Runbooks — write these before go-live

| Runbook | Trigger | Key steps |
|---|---|---|
| RB01 Rail outage | Raast unavailable | Confirm scope; switch eligible products to the alternate rail; notify channels and agencies; suspend RtP dispatch; reconcile on recovery |
| RB02 Aggregator outage | Switch down | Confirm; expect reversals; hold `PENDING_REVERSAL` items; reconcile against the switch's file on recovery |
| RB03 Agency system outage | Quote/notify API failing | Circuit breaker on; serve cached payables where safe; queue notifications; **do not guess amounts** |
| RB04 `UNCERTAIN` spike | Queue depth alert | Identify the failing integration; run the resolver; escalate to the partner; consider disabling that channel |
| RB05 Recon file missing or malformed | Expected file absent by SLA | Chase the partner; do **not** reconcile a partial file; hold the run; notify the agency of delayed certification |
| RB06 Control assertion failure | §10.8 fails | **Freeze sweeps immediately**; identify the entries; engage engineering; do not post a plug entry to make it balance |
| RB07 Duplicate-payment storm | Duplicate rate alert | Identify the source channel; rate-limit it; batch-refund; notify affected payers |
| RB08 Cheque return batch | Returns file received | Process the cascade (§14.6); verify balances restored; notify |
| RB09 Peak-day | Deadline approaching | Execute the §19.3 playbook |
| RB10 Suspected fraud | Alert or report | Preserve evidence; freeze the specific payer/channel, not the platform; notify compliance; prepare the regulator report |
| RB11 Scroll rejected | Treasury ack shows rejects | Identify the head errors; reclassify; supplementary scroll; **never edit and resend the original** |
| RB12 DR failover | Site loss | Execute and *time* the documented failover; verify ledger integrity and hash chain before resuming writes |

### 22.3 Ops calendar

| When | Activity |
|---|---|
| Continuous | Monitor queues, alerts, `UNCERTAIN` |
| Each rail cycle | Verify settlement, post T02 |
| Daily 18:00 `[A]` | Cut-off; teller till closes |
| Daily EOD | Ingest statements and switch files; run three-way recon; generate scrolls; run the five controls |
| Daily morning | Execute sweeps; verify treasury acks; review break register; issue the recon certificate |
| Weekly | Break ageing review; auto-match rate trend; partner escalations |
| Monthly | Period close; agency statements; fee invoices; SLA report |
| Quarterly | DR rehearsal; access recertification; control self-assessment |
| Annually | Fiscal-year close; head rollover; retention/archival run; penetration test |

### 22.4 Support model

L1 (payer-facing, via the channel or agency) → L2 (platform ops, with the 360° views) → L3 (engineering). Publish the ten questions L1 must be able to answer without escalating — "did my payment go through", "where is my receipt", "why is my bill higher than last week", "I paid twice", "my cheque bounced" — and make each answerable from one screen. If L1 must escalate to answer "did my payment go through", the back office is not finished.

### 22.5 Sandbox

A full sandbox is a commercial requirement, not a nicety: it is how banks and agencies certify. It needs deterministic test data, a rail simulator with **injectable failures** (timeout, reject, late confirmation, duplicate, partial), a cheque simulator with settable clear/return outcomes, a clock control for testing surcharge accrual and expiry, and a certification suite that produces a pass/fail report the partner can sign.

### 22.6 Deployment architecture (for the demo)

A **modular monolith** on PostgreSQL, with the twelve §5 capabilities as enforced module boundaries, plus a worker process for the outbox and scheduled jobs. Rationale: the ledger and cash-application invariants (§6.4, §10) depend on multi-table transactions. Splitting them across services means distributed transactions or eventual consistency, and eventually-consistent money is how a demo gets torn apart by a reviewer who asks one hard question. Keep the boundaries clean so extraction is possible later; do not pay the distributed-systems cost before you have the volume to justify it.

```
┌──────────────────────────────────────────────────────────────┐
│  Edge: TLS/mTLS termination · WAF · rate limit · JWS verify  │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  API layer:  /v1  /switch/v1  /admin/v1  /public/v1          │
├──────────────────────────────────────────────────────────────┤
│  Domain modules (single deployable, enforced boundaries)     │
│  config · obligation · resolution · initiation · rtp         │
│  instrument · ledger · settlement · recon · evidence · risk  │
├──────────────────────────────────────────────────────────────┤
│  Rail adapters:  raast · 1link · prism · card · wallet · cash │
│  (all uncertainty about scheme specifics lives HERE)         │
├──────────────────────────────────────────────────────────────┤
│  PostgreSQL (primary + sync replica + read replicas)         │
│  Redis (idempotency cache, rate limits, config cache)        │
│  Object storage (receipts, scrolls, recon source files)      │
└──────────────────────────────────────────────────────────────┘
        │                                    │
        ▼                                    ▼
┌──────────────────┐                ┌─────────────────────────┐
│ Worker: outbox   │                │ Scheduler: expiry,       │
│ relay, webhooks, │                │ surcharge, reminders,    │
│ PDF, notify      │                │ recon, sweep, controls   │
└──────────────────┘                └─────────────────────────┘
```

---

## 23. Database Schema (PostgreSQL DDL — core tables)

Abbreviated to the tables that carry the load-bearing invariants. Generate the remainder from §6 using the same conventions: `id UUID PK DEFAULT gen_random_uuid()`, `created_at`/`updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, money as `BIGINT` minor units, enums as PostgreSQL `TEXT` with `CHECK` constraints (easier to evolve than native enums), and `agency_id` on every tenant-scoped table for row-level security.

```sql
-- ============ EXTENSIONS & CONVENTIONS ============
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy narrative/name matching (§11.6)

-- ============ AGENCY & PRODUCT ============
CREATE TABLE agency (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   VARCHAR(12)  NOT NULL UNIQUE,
  name                   VARCHAR(200) NOT NULL,
  tier                   TEXT NOT NULL CHECK (tier IN
                           ('FEDERAL','PROVINCIAL','LOCAL','AUTONOMOUS_BODY','JUDICIAL')),
  jurisdiction           VARCHAR(10)  NOT NULL,
  legal_entity_name      VARCHAR(200) NOT NULL,
  treasury_account_iban  VARCHAR(34),
  treasury_bank_bic      VARCHAR(11),
  consolidated_fund_ref  VARCHAR(50),
  settlement_model       TEXT NOT NULL CHECK (settlement_model IN
                           ('COLLECTOR_OF_RECORD','PASS_THROUGH','HYBRID')),
  timezone               VARCHAR(40) NOT NULL DEFAULT 'Asia/Karachi',
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 7,
  default_cutoff_time    TIME NOT NULL DEFAULT '18:00',
  sweep_schedule         TEXT NOT NULL DEFAULT 'T1_MORNING',
  status                 TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reference_scheme (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           VARCHAR(30) NOT NULL UNIQUE,
  agency_id      UUID REFERENCES agency(id),
  total_length   SMALLINT NOT NULL,
  charset        TEXT NOT NULL DEFAULT 'NUMERIC'
                   CHECK (charset IN ('NUMERIC','ALPHANUMERIC_UPPER')),
  prefix         VARCHAR(8),
  pattern_regex  VARCHAR(200) NOT NULL,
  checksum_algo  TEXT NOT NULL CHECK (checksum_algo IN
                   ('DAMM','LUHN','MOD_97_10','MOD_11','NONE')),
  sequence_digits SMALLINT NOT NULL DEFAULT 6,
  random_digits   SMALLINT NOT NULL DEFAULT 4,
  collision_policy TEXT NOT NULL DEFAULT 'REJECT_AMBIGUOUS',
  is_platform_minted BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revenue_head (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      UUID NOT NULL REFERENCES agency(id),
  code           VARCHAR(20) NOT NULL,
  name           VARCHAR(200) NOT NULL,
  parent_id      UUID REFERENCES revenue_head(id),
  fund           TEXT NOT NULL CHECK (fund IN
                   ('FEDERAL_CONSOLIDATED','PROVINCIAL_CONSOLIDATED','PUBLIC_ACCOUNT','OTHER')),
  object_class   TEXT NOT NULL CHECK (object_class IN
                   ('TAX_RECEIPT','NON_TAX_RECEIPT','DEPOSIT','FEE','FINE','OTHER')),
  is_refundable_deposit BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  UNIQUE (agency_id, code, effective_from)
);

CREATE TABLE collection_product (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID NOT NULL REFERENCES agency(id),
  code                  VARCHAR(30) NOT NULL,
  name                  VARCHAR(200) NOT NULL,
  category              TEXT NOT NULL CHECK (category IN
                          ('TAX','DUTY','FINE','PENALTY','FEE','BILL','STAMP','DEPOSIT','MISC')),
  reference_scheme_id   UUID NOT NULL REFERENCES reference_scheme(id),
  secondary_lookup_keys JSONB NOT NULL DEFAULT '[]',
  amount_rule           TEXT NOT NULL CHECK (amount_rule IN ('FIXED','ASSESSED','OPEN','MIN_MAX')),
  fixed_amount_minor    BIGINT,
  min_amount_minor      BIGINT,
  max_amount_minor      BIGINT,
  allow_partial         BOOLEAN NOT NULL DEFAULT FALSE,
  min_partial_pct       NUMERIC(5,2),
  allow_overpayment     BOOLEAN NOT NULL DEFAULT FALSE,
  overpay_treatment     TEXT NOT NULL DEFAULT 'REJECT' CHECK (overpay_treatment IN
                          ('REJECT','CREDIT_ON_ACCOUNT','AUTO_REFUND','ABSORB')),
  underpay_tolerance_minor BIGINT NOT NULL DEFAULT 0,
  overpay_tolerance_minor  BIGINT NOT NULL DEFAULT 0,
  rounding_rule         TEXT NOT NULL DEFAULT 'NONE',
  allowed_channels      TEXT[] NOT NULL,
  allowed_instruments   TEXT[] NOT NULL DEFAULT '{}',
  instrument_credit_policy TEXT NOT NULL DEFAULT 'ON_CLEARING' CHECK (instrument_credit_policy IN
                          ('ON_CLEARING','PROVISIONAL_ON_LODGEMENT','PROVISIONAL_WITH_GATE_HOLD')),
  expiry_rule           JSONB NOT NULL DEFAULT '{"type":"NEVER"}',
  surcharge_rule        JSONB,
  early_discount_rule   JSONB,
  fee_schedule_id       UUID,
  fee_bearer            TEXT NOT NULL DEFAULT 'AGENCY' CHECK (fee_bearer IN ('PAYER','AGENCY','SPLIT')),
  default_revenue_head_id UUID NOT NULL REFERENCES revenue_head(id),
  head_mapping          JSONB NOT NULL DEFAULT '{}',
  allocation_waterfall  TEXT NOT NULL DEFAULT 'PENALTY_FIRST' CHECK (allocation_waterfall IN
                          ('OLDEST_FIRST','PENALTY_FIRST','PRINCIPAL_FIRST','PRO_RATA','EXPLICIT_ONLY')),
  underpay_policy       TEXT NOT NULL DEFAULT 'HOLD_AS_UNAPPLIED' CHECK (underpay_policy IN
                          ('HOLD_AS_UNAPPLIED','REJECT_AND_RETURN')),
  requires_payer_identification BOOLEAN NOT NULL DEFAULT TRUE,
  service_gating        TEXT NOT NULL DEFAULT 'NONE' CHECK (service_gating IN
                          ('NONE','BLOCKS_SERVICE','RELEASES_GOODS')),
  deposit_refundable    BOOLEAN NOT NULL DEFAULT FALSE,
  cutoff_time           TIME,
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  UNIQUE (agency_id, code, effective_from),
  CHECK (amount_rule <> 'FIXED' OR fixed_amount_minor IS NOT NULL),
  CHECK (NOT allow_partial OR allow_partial IS NOT NULL)
);

-- ============ PAYER ============
CREATE TABLE payer (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_type          TEXT NOT NULL CHECK (payer_type IN
                        ('INDIVIDUAL','SOLE_PROPRIETOR','AOP','COMPANY','GOVERNMENT','NON_RESIDENT')),
  primary_id_type     TEXT NOT NULL,
  primary_id_hash     BYTEA NOT NULL,             -- keyed hash: searchable, not reversible
  primary_id_enc      BYTEA NOT NULL,             -- envelope-encrypted actual value
  primary_id_last4    CHAR(4) NOT NULL,
  name                VARCHAR(200) NOT NULL,
  msisdn_e164         VARCHAR(20),
  email               VARCHAR(200),
  raast_id_type       TEXT CHECK (raast_id_type IN ('MSISDN','EMAIL','NATIONAL_ID','FREE_TEXT')),
  raast_id_value      VARCHAR(120),
  raast_id_expires_on DATE,                       -- [V] Raast IDs support expiry
  kyc_level           TEXT NOT NULL DEFAULT 'NONE',
  risk_rating         TEXT NOT NULL DEFAULT 'LOW',
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (primary_id_type, primary_id_hash)
);
CREATE INDEX ix_payer_name_trgm ON payer USING gin (name gin_trgm_ops);
CREATE INDEX ix_payer_msisdn    ON payer (msisdn_e164);

CREATE TABLE payer_account (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id      UUID REFERENCES payer(id),
  agency_id     UUID NOT NULL REFERENCES agency(id),
  product_id    UUID NOT NULL REFERENCES collection_product(id),
  crn           VARCHAR(30) NOT NULL,
  account_label VARCHAR(200),
  attributes    JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (agency_id, crn)
);

-- ============ ASSESSMENT ============
CREATE TABLE assessment (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  psid                     VARCHAR(30) NOT NULL UNIQUE,
  agency_id                UUID NOT NULL REFERENCES agency(id),
  product_id               UUID NOT NULL REFERENCES collection_product(id),
  payer_id                 UUID REFERENCES payer(id),
  payer_account_id         UUID REFERENCES payer_account(id),
  payer_snapshot           JSONB NOT NULL,
  external_ref             VARCHAR(80),
  description              VARCHAR(300) NOT NULL,
  currency                 CHAR(3) NOT NULL DEFAULT 'PKR',
  assessed_amount_minor    BIGINT NOT NULL CHECK (assessed_amount_minor >= 0),
  surcharge_accrued_minor  BIGINT NOT NULL DEFAULT 0,
  discount_applied_minor   BIGINT NOT NULL DEFAULT 0,
  payable_amount_minor     BIGINT NOT NULL,
  allocated_amount_minor   BIGINT NOT NULL DEFAULT 0,
  balance_minor            BIGINT NOT NULL,
  issue_date               DATE NOT NULL,
  due_date                 DATE NOT NULL,
  expiry_date              DATE,
  status                   TEXT NOT NULL CHECK (status IN
                             ('DRAFT','ISSUED','PARTIALLY_PAID','SETTLED','OVERDUE','EXPIRED',
                              'CANCELLED','AMENDED','WRITTEN_OFF','CLOSED')),
  allow_partial_override   BOOLEAN,
  service_gate_token       VARCHAR(60),
  service_gate_released_at TIMESTAMPTZ,
  source                   TEXT NOT NULL,
  version                  INTEGER NOT NULL DEFAULT 1,
  supersedes_id            UUID REFERENCES assessment(id),
  metadata                 JSONB NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Surcharge is a LINE ITEM inside assessed_amount_minor; surcharge_accrued_minor is a
  -- denormalised copy of that line total. Adding it here would double-count (see 6.4).
  CONSTRAINT ck_payable  CHECK (payable_amount_minor
                                = assessed_amount_minor - discount_applied_minor),
  CONSTRAINT ck_balance  CHECK (balance_minor = payable_amount_minor - allocated_amount_minor)
);
CREATE INDEX ix_assessment_agency_status ON assessment (agency_id, status)
  WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE');
CREATE INDEX ix_assessment_due       ON assessment (due_date) WHERE status <> 'SETTLED';
CREATE INDEX ix_assessment_metadata  ON assessment USING gin (metadata jsonb_path_ops);

CREATE TABLE assessment_line_item (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id       UUID NOT NULL REFERENCES assessment(id),
  seq                 SMALLINT NOT NULL,
  line_type           TEXT NOT NULL CHECK (line_type IN
                        ('PRINCIPAL','SURCHARGE','PENALTY','INTEREST','FEE','TAX_ON_FEE','ROUNDING','ARREAR')),
  revenue_head_id     UUID NOT NULL REFERENCES revenue_head(id),
  tax_period          VARCHAR(20),
  description         VARCHAR(200),
  amount_minor        BIGINT NOT NULL,
  allocated_minor     BIGINT NOT NULL DEFAULT 0,
  allocation_priority SMALLINT NOT NULL DEFAULT 100,
  UNIQUE (assessment_id, seq),
  CHECK (allocated_minor <= amount_minor OR amount_minor < 0)
);

-- Resolution index: THE table that makes §19.2's 300 ms budget achievable.
CREATE TABLE resolution_index (
  id                  BIGSERIAL PRIMARY KEY,
  agency_id           UUID NOT NULL REFERENCES agency(id),
  key_type            TEXT NOT NULL,
  key_value_norm      VARCHAR(80) NOT NULL,
  key_value_raw       VARCHAR(120) NOT NULL,
  assessment_id       UUID NOT NULL REFERENCES assessment(id),
  is_open             BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at          TIMESTAMPTZ,
  UNIQUE (key_type, key_value_norm, assessment_id)
);
CREATE INDEX ix_resolution_lookup ON resolution_index (key_type, key_value_norm) WHERE is_open;

-- ============ INTENT, PAYMENT, ALLOCATION ============
CREATE TABLE payment_intent (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_reference      VARCHAR(30) NOT NULL UNIQUE,
  channel               TEXT NOT NULL,
  initiating_institution_id UUID,
  payer_id              UUID REFERENCES payer(id),
  third_party_payer     JSONB,
  requested_amount_minor BIGINT NOT NULL CHECK (requested_amount_minor > 0),
  fee_amount_minor      BIGINT NOT NULL DEFAULT 0,
  tax_on_fee_minor      BIGINT NOT NULL DEFAULT 0,
  total_debit_minor     BIGINT NOT NULL,
  currency              CHAR(3) NOT NULL DEFAULT 'PKR',
  requested_allocations JSONB,
  resolution_token_jti  UUID,
  derived_rule_version  VARCHAR(20),
  quote_expires_at      TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL CHECK (status IN
                          ('CREATED','AUTHORISED','CAPTURED','COMPLETED','COMPLETED_LATE',
                           'EXPIRED','ABANDONED','FAILED')),
  idempotency_key       VARCHAR(64),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_reference     VARCHAR(30) NOT NULL UNIQUE,
  intent_id             UUID REFERENCES payment_intent(id),
  agency_id             UUID REFERENCES agency(id),
  channel               TEXT NOT NULL,
  rail                  TEXT NOT NULL CHECK (rail IN
                          ('RAAST','IBFT_1LINK','PRISM_RTGS','PAYPAK','CARD_SCHEME',
                           'INTERNAL_BOOK','CASH','CHEQUE_CLEARING','WALLET')),
  direction             TEXT NOT NULL DEFAULT 'INBOUND' CHECK (direction IN ('INBOUND','OUTBOUND')),
  instrument_id         UUID,
  bulk_batch_id         UUID,
  gross_amount_minor    BIGINT NOT NULL CHECK (gross_amount_minor > 0),
  fee_amount_minor      BIGINT NOT NULL DEFAULT 0,
  net_to_agency_minor   BIGINT NOT NULL,
  unapplied_amount_minor BIGINT NOT NULL DEFAULT 0,
  currency              CHAR(3) NOT NULL DEFAULT 'PKR',
  status                TEXT NOT NULL CHECK (status IN
                          ('INITIATED','CONFIRMED','UNCERTAIN','FAILED','STUCK',
                           'REVERSED','PARTIALLY_REVERSED')),
  finality              TEXT NOT NULL DEFAULT 'FINAL' CHECK (finality IN ('PROVISIONAL','FINAL')),
  value_date                 DATE NOT NULL,
  obligation_discharge_date  DATE NOT NULL,
  cutoff_reason              VARCHAR(30),
  cutoff_rule_version        VARCHAR(20),
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at          TIMESTAMPTZ,
  rail_e2e_id           VARCHAR(35),
  rail_txn_id           VARCHAR(35),
  rail_uetr             UUID,
  rail_instr_id         VARCHAR(35),
  switch_stan           VARCHAR(12),
  switch_rrn            VARCHAR(20),
  acquirer_id           VARCHAR(20),
  payer_account_masked  VARCHAR(40),
  payer_bank_bic        VARCHAR(11),
  remittance_raw        TEXT,
  application_trace     JSONB,
  settlement_batch_id   UUID,
  duplicate_of_payment_id UUID REFERENCES payment(id),
  uncertain_resolution_source VARCHAR(30),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The four anti-double-post constraints (§6.8)
CREATE UNIQUE INDEX ux_payment_rail_e2e ON payment (rail, rail_e2e_id)
  WHERE rail_e2e_id IS NOT NULL;
CREATE UNIQUE INDEX ux_payment_switch   ON payment (acquirer_id, switch_stan, switch_rrn, value_date)
  WHERE switch_stan IS NOT NULL;
CREATE UNIQUE INDEX ux_payment_intent   ON payment (intent_id)
  WHERE intent_id IS NOT NULL AND status NOT IN ('REVERSED','FAILED');
CREATE UNIQUE INDEX ux_payment_instr    ON payment (instrument_id)
  WHERE instrument_id IS NOT NULL;
CREATE INDEX ix_payment_valuedate ON payment (value_date, agency_id);
CREATE INDEX ix_payment_unapplied ON payment (received_at)
  WHERE unapplied_amount_minor > 0;
CREATE INDEX ix_payment_uncertain ON payment (received_at) WHERE status = 'UNCERTAIN';
CREATE INDEX ix_payment_remit_trgm ON payment USING gin (remittance_raw gin_trgm_ops);

CREATE TABLE payment_allocation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        UUID NOT NULL REFERENCES payment(id),
  assessment_id     UUID NOT NULL REFERENCES assessment(id),
  line_item_id      UUID NOT NULL REFERENCES assessment_line_item(id),
  revenue_head_id   UUID NOT NULL REFERENCES revenue_head(id),
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),
  allocation_basis  TEXT NOT NULL CHECK (allocation_basis IN
                      ('EXPLICIT','WATERFALL','MANUAL','SYSTEM_REALLOCATION')),
  status            TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','REVERSED')),
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at       TIMESTAMPTZ,
  reversal_reason   VARCHAR(60),
  applied_by_user_id UUID,
  approval_id       UUID,
  CHECK (allocation_basis <> 'MANUAL' OR approval_id IS NOT NULL)
);
CREATE INDEX ix_alloc_payment    ON payment_allocation (payment_id);
CREATE INDEX ix_alloc_assessment ON payment_allocation (assessment_id) WHERE status = 'APPLIED';
CREATE INDEX ix_alloc_head       ON payment_allocation (revenue_head_id, applied_at)
  WHERE status = 'APPLIED';

-- ============ LEDGER ============
CREATE TABLE ledger_account (
  code           VARCHAR(20) PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  account_type   TEXT NOT NULL CHECK (account_type IN
                   ('ASSET','LIABILITY','INCOME','EXPENSE','EQUITY','MEMO')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DR','CR')),
  agency_id      UUID REFERENCES agency(id),
  currency       CHAR(3) NOT NULL DEFAULT 'PKR',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE journal_entry (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no            BIGSERIAL UNIQUE,
  event_type          VARCHAR(40) NOT NULL,
  source_type         VARCHAR(30) NOT NULL,
  source_id           UUID NOT NULL,
  sequence            SMALLINT NOT NULL DEFAULT 1,
  agency_id           UUID REFERENCES agency(id),
  value_date          DATE NOT NULL,
  posted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  narrative           VARCHAR(300),
  reversal_of_entry_id UUID REFERENCES journal_entry(id),
  approval_id         UUID,
  correlation_id      UUID,
  hash_prev           BYTEA,
  hash_self           BYTEA,
  UNIQUE (source_type, source_id, event_type, sequence)   -- idempotent posting
);

CREATE TABLE journal_line (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        UUID NOT NULL REFERENCES journal_entry(id),
  seq             SMALLINT NOT NULL,
  account_code    VARCHAR(20) NOT NULL REFERENCES ledger_account(code),
  direction       TEXT NOT NULL CHECK (direction IN ('DR','CR')),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        CHAR(3) NOT NULL DEFAULT 'PKR',
  revenue_head_id UUID REFERENCES revenue_head(id),
  dimension       JSONB NOT NULL DEFAULT '{}',
  UNIQUE (entry_id, seq)
);
CREATE INDEX ix_jl_account_date ON journal_line (account_code);
CREATE INDEX ix_jl_head         ON journal_line (revenue_head_id) WHERE revenue_head_id IS NOT NULL;

-- Balance + immutability enforcement (§10.5)
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE dr BIGINT; cr BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='DR' THEN amount_minor END),0),
         COALESCE(SUM(CASE WHEN direction='CR' THEN amount_minor END),0)
    INTO dr, cr FROM journal_line WHERE entry_id = NEW.entry_id;
  IF dr <> cr THEN
    RAISE EXCEPTION 'Unbalanced journal entry %: DR % <> CR %', NEW.entry_id, dr, cr;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

CREATE RULE je_no_update AS ON UPDATE TO journal_entry DO INSTEAD NOTHING;
CREATE RULE je_no_delete AS ON DELETE TO journal_entry DO INSTEAD NOTHING;
CREATE RULE jl_no_update AS ON UPDATE TO journal_line  DO INSTEAD NOTHING;
CREATE RULE jl_no_delete AS ON DELETE TO journal_line  DO INSTEAD NOTHING;

-- ============ IDEMPOTENCY ============
CREATE TABLE idempotency_record (
  institution_id   UUID NOT NULL,
  endpoint         VARCHAR(120) NOT NULL,
  idempotency_key  VARCHAR(64) NOT NULL,
  request_fingerprint BYTEA NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETE')),
  response_status  SMALLINT,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  PRIMARY KEY (institution_id, endpoint, idempotency_key)   -- this IS the lock
);

-- ============ RECONCILIATION ============
CREATE TABLE recon_run (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no             BIGSERIAL UNIQUE,
  recon_type         TEXT NOT NULL,
  business_date      DATE NOT NULL,
  agency_id          UUID REFERENCES agency(id),
  rail               TEXT,
  status             TEXT NOT NULL DEFAULT 'PENDING',
  matched_count      INTEGER NOT NULL DEFAULT 0,
  matched_amount_minor BIGINT NOT NULL DEFAULT 0,
  break_count        INTEGER NOT NULL DEFAULT 0,
  break_amount_minor BIGINT NOT NULL DEFAULT 0,
  auto_match_rate_pct NUMERIC(6,3),
  control_totals     JSONB NOT NULL DEFAULT '{}',
  supersedes_run_id  UUID REFERENCES recon_run(id),
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ
);

CREATE TABLE recon_source_record (
  id             BIGSERIAL PRIMARY KEY,
  run_id         UUID NOT NULL REFERENCES recon_run(id),
  source         TEXT NOT NULL CHECK (source IN
                   ('PLATFORM','RAIL','SWITCH','BANK_STATEMENT','AGENCY_SUBLEDGER',
                    'TREASURY_ACK','CHANNEL_PARTNER','TILL')),
  file_id        UUID,
  line_no        INTEGER,
  raw_line       TEXT,
  parsed         JSONB NOT NULL,
  amount_minor   BIGINT,
  value_date     DATE,
  match_key      VARCHAR(80),
  matched        BOOLEAN NOT NULL DEFAULT FALSE,
  match_id       UUID
);
CREATE INDEX ix_rsr_run_unmatched ON recon_source_record (run_id, source) WHERE NOT matched;
CREATE INDEX ix_rsr_matchkey      ON recon_source_record (match_key);

CREATE TABLE recon_source_file (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT NOT NULL,
  partner_id   UUID,
  business_date DATE NOT NULL,
  filename     VARCHAR(300) NOT NULL,
  file_hash    BYTEA NOT NULL,
  declared_count INTEGER,
  declared_total_minor BIGINT,
  parsed_count   INTEGER,
  parsed_total_minor BIGINT,
  status       TEXT NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, file_hash)                        -- never ingest the same file twice
);

CREATE TABLE recon_break (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES recon_run(id),
  break_code         VARCHAR(4) NOT NULL,
  severity           TEXT NOT NULL,
  amount_minor       BIGINT NOT NULL,
  currency           CHAR(3) NOT NULL DEFAULT 'PKR',
  business_date      DATE NOT NULL,
  agency_id          UUID REFERENCES agency(id),
  rail               TEXT,
  channel            TEXT,
  source_a_record_id BIGINT REFERENCES recon_source_record(id),
  source_b_record_id BIGINT REFERENCES recon_source_record(id),
  payment_id         UUID REFERENCES payment(id),
  assessment_id      UUID REFERENCES assessment(id),
  narrative_raw      TEXT,
  suggested_resolution JSONB,
  status             TEXT NOT NULL DEFAULT 'OPEN',
  assigned_to_user_id UUID,
  sla_due_at         TIMESTAMPTZ,
  resolution_type    VARCHAR(30),
  adjustment_id      UUID,
  approval_id        UUID,
  resolved_at        TIMESTAMPTZ,
  resolved_by_user_id UUID,
  resolution_note    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_break_open ON recon_break (status, sla_due_at) WHERE status <> 'RESOLVED';

-- ============ MAKER-CHECKER ============
CREATE TABLE approval (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   VARCHAR(40) NOT NULL,
  subject_id     UUID NOT NULL,
  action         VARCHAR(40) NOT NULL,
  amount_minor   BIGINT,
  payload        JSONB NOT NULL,
  maker_user_id  UUID NOT NULL,
  maker_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  checker_user_id UUID,
  checker_at     TIMESTAMPTZ,
  state          TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (state IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  comment        TEXT,
  CONSTRAINT ck_segregation CHECK (checker_user_id IS NULL OR checker_user_id <> maker_user_id)
);

-- ============ AUDIT (hash-chained) ============
CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('USER','SERVICE','SYSTEM','INSTITUTION')),
  actor_id       VARCHAR(80) NOT NULL,
  action         VARCHAR(60) NOT NULL,
  entity_type    VARCHAR(40) NOT NULL,
  entity_id      VARCHAR(80),
  before_json    JSONB,
  after_json     JSONB,
  ip             INET,
  user_agent     VARCHAR(300),
  correlation_id UUID,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  hash_prev      BYTEA,
  hash_self      BYTEA NOT NULL
);
CREATE RULE audit_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- ============ OUTBOX ============
CREATE TABLE outbox_event (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID NOT NULL UNIQUE,
  aggregate_type VARCHAR(40) NOT NULL,
  aggregate_id   UUID NOT NULL,
  sequence       INTEGER NOT NULL,
  event_type     VARCHAR(60) NOT NULL,
  payload        JSONB NOT NULL,
  correlation_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ
);
CREATE INDEX ix_outbox_unpublished ON outbox_event (id) WHERE published_at IS NULL;
```

### 23.1 Row-level security for tenant isolation

```sql
ALTER TABLE assessment ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_assessment_tenant ON assessment
  USING (agency_id = current_setting('app.current_agency_id', true)::uuid
         OR current_setting('app.is_platform_role', true) = 'true');
-- Repeat for every tenant-scoped table. Set app.current_agency_id per request
-- from the validated token, never from a request parameter.
```
---

## 24. Demo Data Pack

Everything in `demo-data/` is generated by `scripts/generate_demo_data.py` — deterministic (seed `20260730`), so a re-run reproduces byte-identical files. The script runs 17 consistency and break-materialisation checks before it writes and refuses to emit an inconsistent dataset — including checks that every planted break is actually present in the source files, that provenance flags agree with the source files, that RtP fulfilment is linked in both directions, and that every instrument type is permitted by its product. It is fully deterministic (no `datetime.now()`), so two runs produce byte-identical output. **Treat `expected-results.json` as a test fixture, not documentation.**

### 24.1 What is in the pack

| File | Rows | Contents |
|---|---|---|
| `agencies.csv` | 9 | FBR, PRA, SRB, ETPB, PSCA, WASA, LHC, BOR, NADRA. Deliberately spans all three settlement models (§1.5): `HYBRID` (FBR, ETPB, BOR), `COLLECTOR_OF_RECORD` (PRA, PSCA, WASA), `PASS_THROUGH` (SRB, LHC, NADRA). |
| `revenue_heads.csv` | 35 | Government chart of accounts, with tax-type-specific surcharge and penalty heads, two **refundable-deposit** heads in the Public Account (`J07910`, `R08910`), and per-jurisdiction rounding-relief heads. |
| `reference_schemes.csv` | 9 | **Seven** 17-digit Damm-protected PSID schemes with distinct agency prefixes, one 13-digit Damm-protected WASA consumer-number scheme, and one **legacy 14-digit Luhn** scheme (NADRA) which carries no platform product code — proving the platform accepts references it did not design. |
| `products.csv` | 20 | Every category (`TAX`, `DUTY`, `FINE`, `PENALTY`, `FEE`, `BILL`, `STAMP`, `DEPOSIT`), **all five allocation waterfalls**, all three instrument-credit policies, all four overpayment treatments, both service-gating modes. |
| `payers.csv` | 40 | 15 companies (NTN) and 25 individuals (CNIC). Two carry a **Raast ID expiry date**, one of them already lapsed, to exercise `ALIAS_EXPIRED`. |
| `payer_accounts.csv` | 27 | 15 vehicle relationships and 12 water connections — the durable CRN records that make secondary-key lookup work. |
| `assessments.csv` | 164 | 119 `SETTLED`, 22 `OVERDUE`, 16 `ISSUED`, 7 `PARTIALLY_PAID`. Multi-head, arrears across three billing periods, early-payment discounts, expiry windows. |
| `assessment_line_items.csv` | 282 | Head-level breakdown. Sums exactly to each assessment's assessed amount. |
| `payments.csv` | 115 | 113 `CONFIRMED`, 1 `REVERSED` (the bounced cheque), 1 `UNCERTAIN`. **All 12 channels and all 7 rails represented.** |
| `payment_allocations.csv` | 218 | 212 `APPLIED`, 6 `REVERSED`. |
| `instruments.csv` | 6 | 3 `CLEARED`, 1 `RETURNED` (insufficient funds after provisional credit), 1 `HELD_POST_DATED`, 1 `IN_CLEARING`. |
| `requests_to_pay.csv` | 14 | **Eight distinct lifecycle states**: `FULFILLED` ×4, `DELIVERED` ×4, `PRESENTED`, `DECLINED`, `EXPIRED`, `ACCEPTED_FUTURE_DATED`, `CANCELLED`, `UNDELIVERABLE` (lapsed alias). Includes a 3-row bulk campaign. Each `FULFILLED` RtP is linked in **both directions** to a payment on the `RTP` channel whose `EndToEndId` **is** the `rtp_reference`, exactly as §8.3 step 9 specifies. |
| `bank_statement_camt053.csv` | 114 | The camt.053 leg of three-way recon. 113 rows fall in the 2026-07-27 → 07-31 window; one is value-dated 2026-07-16 — the deliberately aged unapplied receipt behind break `B06`. |
| `switch_settlement_1link.csv` | 40 | The aggregator leg, with a contracted `switch_fee_minor` per row so fee variance is detectable. Includes the `UNCERTAIN` payment — the switch says it happened, the platform does not yet know, which is the whole point of that state. |
| `rail_settlement_raast.csv` | 42 | Transaction rows plus a `cycle_declared_net_minor` per cycle, so cycle netting can be checked against its constituents. |
| `scroll_fbr_20260730.csv` | 18 | Allocation-granularity treasury scroll lines, each with its receipt number and a per-line `ack_status`. |
| `scroll-sample.txt` | — | The same scroll as a fixed-width `HDR`/`DTL`/`HTL`/`TRL` file with a SHA-256 over the detail block, as a treasury would actually receive it. |
| `bulk_payment_input.csv` | 13 | Bulk corporate input file: 12 valid withholding challans plus **one row referencing an already-settled PSID**, so the pre-validation reject path has a real anchor. |
| `qr-payloads.json` | 4 | EMVCo merchant-presented QRs: dynamic with amount, dynamic open-amount, static counter, and one **deliberately CRC-corrupted**. |
| `expected-results.json` | — | Every control total, distribution, head-wise and agency-wise position, the planted-break manifest, the narrative-parsing corpus, and the demo walkthrough anchors. |

### 24.2 Control totals (from `expected-results.json`)

| Measure | Amount (PKR) |
|---|---|
| Total assessed | 27,610,165.00 |
| Total payable (after discounts) | 27,608,915.00 |
| Total allocated | 23,206,523.00 |
| Total outstanding balance | 4,402,392.00 |
| Payments gross — confirmed only | 23,583,823.00 |
| Payments gross — all statuses | 24,229,435.00 |
| Allocations applied | 23,206,523.00 |
| Allocations reversed (the bounced cheque) | 644,112.00 |
| Unapplied receipts | 377,300.00 |
| Bank statement credit total | 23,308,721.00 |
| Switch settlement total | 8,711,367.00 |
| Rail settlement transaction total | 8,871,260.00 |
| FBR scroll total, 2026-07-30 | 3,721,325.00 |

Note that **allocations applied equals total allocated exactly**. That identity, plus the per-payment `applied + unapplied = gross` check for live payments, is the whole point: a reviewer can verify the dataset's soundness with a calculator in fifteen seconds. Both are asserted by the generator before it writes.

Agency-wise allocated position: FBR 16,855,296.00 · BOR 3,358,800.00 · PRA 1,253,000.00 · ETPB 723,350.00 · SRB 550,000.00 · LHC 360,000.00 · PSCA 67,500.00 · WASA 26,577.00 · NADRA 12,000.00.

### 24.3 The 11 planted reconciliation breaks

**The recon engine must find exactly these, classify each correctly, and find nothing else.** Business date under reconciliation: **2026-07-30**. Total unexplained: **PKR 890,949.50** across 9 distinct codes — 3 auto-resolvable, 8 requiring human action.

| # | Code | Type | Amount (PKR) | Anchor | Expected handling |
|---|---|---|---|---|---|
| 1 | `B01` | Unmatched credit in bank | 47,500.00 | `HBL20260730UNK01`, narrative `TOKEN TAX LEA 17 1000 PAYMENT AHMED` | **Resolvable.** Narrative → vehicle → open token tax. Analyst proposes `MANUAL` allocation; approver approves. |
| 2 | `B01` | Unmatched credit in bank | 125,000.00 | `HBL20260730UNK02`, narrative `TAX PAYMENT AHMED` | **Not resolvable.** Stays unapplied, ages, escalates; candidate for return to remitter. Never to income. |
| 3 | `B02` | Unmatched payment in platform | 447,552.00 | `P2600019` | Present in the Raast cycle file, absent from the bank statement. Verify with `pacs.028`. |
| 4 | `B03` | Amount mismatch | 50.00 | `P260000D` | Bank **and** switch both short by PKR 50 — fee deducted at source. |
| 5 | `B04` | Duplicate in source | 120,340.00 | STAN `587153` / RRN `26211923800` appearing twice in the 1LINK file | **Auto-suppress** (rule R6). Retain evidence. |
| 6 | `B05` | Timing difference | 3,500.00 | `P2600001` | Platform value date 07-30, bank booking 07-31. **Auto-resolves; must not alarm.** |
| 7 | `B05` | Timing difference | 3,000.00 | `P2600005` | Same. |
| 8 | `B06` | Unapplied receipt aged | 125,000.00 | `P260003H`, aged 14 days | Escalate; propose return to remitter or transfer to unclaimed funds. |
| 9 | `B07` | Fee variance | 7.50 | `P260000N` | Switch fee 17.50 vs contracted 10.00. Recompute, raise with the partner. |
| 10 | `B08` | Settlement shortfall | 12,500.00 | Cycle `RAAST-2026-07-30-C4` | Declared cycle net is PKR 12,500 below the sum of its constituents. **One `CYCLE_VARIANCE` break, not one per transaction.** |
| 11 | `B09` | Scroll rejected | 6,500.00 | Scroll line 13, head `B02391` | `HEAD_NOT_VALID_FOR_PERIOD`. **A classification break, not a cash break** — the money is banked. Reclassify, supplementary scroll. |

Three of the eleven auto-resolve (`B04` and both `B05` rows); the other eight need a human. That ratio is realistic and worth pointing out: a recon engine claiming to auto-resolve everything is not to be trusted.

On the reconciliation date there are **33** platform payments (32 `CONFIRMED` plus the one `UNCERTAIN`), of which **28** match the bank statement exactly. The generator computes that figure rather than asserting it, by tying `end_to_end_id` plus value date plus amount.

### 24.4 Demo walkthrough — the eleven-minute script

Run in this order. Each step has a concrete anchor in the data.

| # | Minutes | Step | What the reviewer sees |
|---|---|---|---|
| 1 | 0:00 | **Resolve `LEA-17-1000`** | One number plate → 3 open payables across **two different agencies**: token tax `31010900000181526` at PKR 10,000.00 (overdue), e-challan `41011300000190123` at PKR 3,750.00 (PKR 1,250.00 early discount still live), e-challan `41011400000286611` at PKR 3,000.00 (overdue) — plus `41011400001606295` returned as `ALREADY_SETTLED` **with its receipt**. Point out that the last one is what prevents duplicate payments. |
| 2 | 1:00 | **Pay one by APP** | Quote → fee disclosed → confirm → receipt in under a second. Show `obligation_discharge_date` alongside `value_date` and explain why they differ (§13.3). |
| 3 | 2:00 | **Scan the QR** | `qr-payloads.json` sample 1. Decode the EMVCo TLV live, show the PSID sitting in tag `62`/`01`, then scan the CRC-corrupted sample and watch it rejected with `QR_CRC_INVALID`. Say the line: *the QR is a reference-transport mechanism, not a payment mechanism.* |
| 4 | 3:00 | **Request to Pay, end to end** | `R260001` → alias `+923011063352`, PKR 11,500.00 token tax → accepted → the fulfilling credit arrives on the `RTP` channel as payment `P260002H`, whose `EndToEndId` **is** `R260001`, and allocates. Then walk the other seven lifecycle states in `requests_to_pay.csv` — `DECLINED` (never auto-retried), `EXPIRED`, `ACCEPTED_FUTURE_DATED`, `CANCELLED`, and the `UNDELIVERABLE` one caused by a **lapsed Raast ID**. |
| 5 | 4:30 | **Multi-head split** | Payment `P260000E` — PKR 943,880.00 on one internet-banking transaction over Raast, split across three revenue heads: `B01101` 920,000.00, `B02388` 12,880.00, `B02391` 11,000.00. Then run the head-wise query and show it is a ledger `SELECT`, not a spreadsheet. |
| 6 | 5:30 | **Bulk corporate file** | Submit `bulk_payment_input.csv`: 13 rows, and row 13 references already-settled PSID `12010100000192486` → **the entire file is rejected** under `REJECT_ALL`. Fix it, resubmit 12 rows, fund with **one** credit of PKR 371,100.00, and get 12 allocations and 12 receipts. |
| 7 | 6:30 | **Cheque linking** | Instrument `IN-0001`: one cheque, three challans, cleared. Then `IN-0004` — cheque `004822` for PKR 644,112.00, provisional credit given, **returned for insufficient funds**. Watch the cascade: 6 allocations reversed, 3 assessments un-settled, 3 receipts voided, surcharge resuming from the *original* due date, service gate re-closed, and dishonour-charge PSID `12010600005120245` raised automatically. **This is the single most convincing thirty seconds available.** |
| 8 | 8:00 | **Run reconciliation** | Ingest all three source files for 2026-07-30. Engine reports 11 breaks. Open each: show `B05` auto-resolving and *not* alarming, `B08` producing one cycle break rather than dozens, `B09` correctly labelled a classification break. |
| 9 | 9:00 | **Resolve a break** | Take break #1. Show the narrative fuzzy-match suggestion, propose the allocation, show the **journal preview**, switch users, approve. Then show that the same user cannot approve their own proposal — the database rejects it. |
| 10 | 10:00 | **Scroll and sweep** | Open `scroll-sample.txt`. Point at the trailer hash and the head totals. Note that provisional funds were **deliberately excluded** from the sweep. |
| 11 | 10:30 | **The five controls** | All five §10.8 assertions green on one screen. Then `UPDATE journal_line` directly in the database and run `verify-chain`: it names the tampered entry. |

### 24.5 Narrative-parsing test corpus

Assert each outcome; these are in `expected-results.json`, and §11.6 carries the same corpus.

| Narrative | Expected outcome |
|---|---|
| `PSID 41011300000190123 INCOME TAX` | `AUTO_APPLY_EXACT` |
| `TAX PYMT 4101-1300-0001-9012-3` | `AUTO_APPLY_AFTER_NORMALISATION` |
| `RF3741011300000190123 PSCA` | `AUTO_APPLY_VIA_RF` |
| `41011300000190124` (check digit +1) | `UNAPPLIED_CHECKSUM_FAILED` |
| `TOKEN TAX LEA 17 1000` | `REVIEW_QUEUE_SCORE_45` — resolvable by vehicle, but below the auto-apply floor |
| `TAX PAYMENT AHMED` | `UNAPPLIED_BREAK_RAISED` |
| `PAYMENT FOR 41011300000190123 AND 71011800000183627` | `REVIEW_QUEUE_AMBIGUOUS_NEVER_GUESS` |

### 24.6 Regenerating and extending

```bash
python3 scripts/generate_demo_data.py          # deterministic; 17 checks before writing
```

To scale up for load testing, raise the loop bounds in the scenario builders; the verification block will keep the dataset honest. **If you change the generator, re-run it and re-read `expected-results.json`** — the design document quotes those figures and they must continue to agree.

---

## 25. Build Plan

Six phases. Each has a demoable outcome and hard acceptance criteria. **Do not start a phase before its predecessor's criteria pass** — the invariants compound.

### Phase 0 — Foundations (build first, no exceptions)

| Deliverable | Acceptance criteria |
|---|---|
| Schema from §23, migrations | All constraints and triggers present |
| Money as `BIGINT` minor units throughout | A test proves no `float`/`numeric` money column exists anywhere |
| Append-only ledger with balanced-entry trigger | Attempting `UPDATE journal_entry` is a no-op; an unbalanced entry raises at commit |
| Hash chaining + `verify-chain` | Tampering with a row is detected and the entry named |
| Damm and Luhn checksums | 10,000-case test: **every** single-digit substitution and **every** adjacent transposition caught |
| ISO 11649 RF encode/validate | Round-trips the demo PSIDs; `mod 97 == 1` asserted |
| Idempotency middleware | Replay returns the stored status and body; different body ⇒ 422; concurrent ⇒ 409 |
| RBAC + row-level security | Agency A cannot read agency B's assessment even with a valid PSID |
| Audit log, hash-chained | Every write produces an audit row |
| Transactional outbox + relay | An event is never published for a rolled-back transaction |
| Demo data loaded | All 8 generator assertions pass against the loaded database, not just the CSVs |

### Phase 1 — Obligation + Resolution (the front door)

| Deliverable | Acceptance criteria |
|---|---|
| Agency, product, head, scheme configuration | A new product goes live with no code change |
| Assessment CRUD with versioned amendment | Amending keeps the PSID and creates `v+1` |
| Line items with head mapping | `Σ line items = assessed`, enforced |
| `resolution_index` maintenance | Populated by outbox/trigger on every assessment write |
| `POST /v1/resolve` for all 17 key types | `LEA-17-1000` returns 3 open + 1 `ALREADY_SETTLED` |
| Derived amounts: surcharge, discount, rounding | `compute_derived(a, date, version)` is deterministic and reproducible |
| `resolution_token` | Signed, 5-minute, binds amount to payable set; tampering rejected |
| Privacy shaping and step-up | CNIC lookup without step-up ⇒ 401 |
| Latency | **p99 ≤ 300 ms** on the demo dataset |

### Phase 2 — Payment capture and cash application (the engine)

| Deliverable | Acceptance criteria |
|---|---|
| Intent with fee and tax-on-fee | `total_debit_minor` correct; zero-fee case fully tested |
| `POST /v1/payments` apply pipeline | End to end ≤ 800 ms p99 |
| Allocation engine, all 5 waterfalls | Golden-file test per waterfall |
| Partial, over, under, tolerance, rounding relief | Every §11.4 row has a passing test |
| Multi-bill and explicit allocation | The QR two-challan anchor settles both, oldest first |
| Duplicate detection, 3 tiers | Hard duplicate rejected; probable duplicate accepted then auto-refunded |
| `UNCERTAIN` state and resolver | Timeout never shown as failure; resolver escalates through all 5 strategies |
| Late and mismatched credits accepted | Credit against an expired intent applies and yields `COMPLETED_LATE` |
| Unapplied receipts | Both demo unapplied receipts land in `2020` with breaks raised |
| Journal templates T01–T30 | Golden-file assertion per template |
| Receipt numbering and rendering | Gapless per agency per day; provisional receipts visibly marked |
| All five §10.8 controls | Green against the full demo dataset |

### Phase 3 — RtP, QR, biller, instruments (the channels)

| Deliverable | Acceptance criteria |
|---|---|
| RtP full state machine | All 15 states reachable; `DECLINED` never auto-retried |
| Late fulfilment after expiry | Accepted as `FULFILLED_LATE`, money applied |
| Bulk RtP campaign with kill switch | 3-row demo campaign dispatches with per-row outcomes |
| Alias resolution incl. `ALIAS_EXPIRED` | The expired-alias demo row is `UNDELIVERABLE` |
| EMVCo QR encode/decode + CRC | All 4 payloads round-trip; the corrupted one rejected |
| Switch four-message contract | Reversal-without-original held as `PENDING_REVERSAL` and auto-paired |
| Instrument lodgement with linking | Σ links ≤ face value enforced |
| All 3 instrument credit policies | Provisional, gate-hold, and on-clearing each tested |
| **Dishonour cascade** | `IN-0004` produces exactly 6 reversed allocations, 3 un-settled assessments, 3 voided receipts, 1 dishonour assessment, gate re-closed, surcharge resumed from the original due date |
| OTC cash with till close | Over/short posts to `5900` and raises a break |
| Bulk file with pre-validation | Control-total mismatch rejects the whole file |

### Phase 4 — Reconciliation, settlement, treasury (the proof)

| Deliverable | Acceptance criteria |
|---|---|
| Source ingestion with control-record validation | Mismatched trailer fails the run; duplicate file hash rejected |
| Matching passes P1–P9 | ≥ 99.5% auto-match on the demo dataset |
| Bounded subset-sum (P6) | Ambiguous subsets raise `B15`, never guess |
| Fee-aware matching | `B07` detected at PKR 7.50 |
| **All 17 break codes implemented; exactly the 11 planted breaks found** | Byte-for-byte agreement with `expected-results.json` |
| Auto-resolution R1–R6 with caps | Exceeding the cap stops auto-resolution and alarms |
| Break ageing, SLA, escalation | Ageing buckets correct against the 14-day unapplied receipt |
| Maker-checker adjustments | Same user cannot approve own proposal — rejected by the database |
| Settlement cycles and DNS netting | Confirmed / settled / swept are three distinct, separately reported figures |
| Value date and cut-off assignment | Fiscal-year-boundary audit report produced |
| Scroll generation | Control total asserted; refuses to emit if it does not tie; ack processing raises `B09` |
| Sweep excluding provisional funds | `PROVISIONAL_FUNDS_NOT_SWEEPABLE` enforced |
| Period close | Posting into a closed period rejected; reopening impossible |

### Phase 5 — Exceptions, evidence, back office, hardening

| Deliverable | Acceptance criteria |
|---|---|
| Refunds with beneficiary default | Override without approval rejected |
| Reversal cascade incl. post-sweep recovery item | Swept money produces an agency receivable, not a silent reversal |
| Recall (`camt.056`) handling | Swept funds ⇒ rejected with the correct reason |
| Chargeback with auto-assembled evidence | Bundle includes receipt, resolution trace, application trace, service delivered |
| Assessment amended downward | Overpayment auto-recognised into `2030` |
| Deposits as liabilities | Never touch `2010`; refund is the happy path |
| Receipt signing + offline QR verification | Verifies with the network disconnected; one altered digit fails |
| Public verification endpoint | No PII beyond a masked name; rate-limited |
| Notifications with quiet hours and caps | Cap enforced per payer per assessment |
| The 15 back-office screens | L1 can answer all ten support questions from one screen each |
| The 12 runbooks | Written, and RB06 and RB12 rehearsed |
| Observability | The four critical alerts fire in a chaos test |
| Load test | 3,000 TPS sustained with exactly-once semantics intact |
| Security review | No PAN anywhere; no PII in logs; break-glass audited |

### 25.1 Suggested sequencing for a demo build

If the goal is a convincing demo rather than production, build Phase 0 fully (it is only a few days and everything downstream depends on it), then **Phase 1 → Phase 2 → the reconciliation slice of Phase 4 → the cheque slice of Phase 3**. That order gets you to the two most persuasive moments — the vehicle lookup and the dishonour cascade — with recon in between to prove the money is real. Cards, mandates, and the full back office can wait.

---

## 26. Test Scenarios

### 26.1 The thirty-six tests that matter most

Group A — **money conservation** (if any of these fail, nothing else matters):

| # | Test | Assertion |
|---|---|---|
| A1 | Every payment in a live state (`CONFIRMED`, `PARTIALLY_REVERSED`) | `Σ applied allocations + unapplied = gross`. Fully `REVERSED` and `UNCERTAIN` payments are excluded by design; the test must assert the exclusion set too. |
| A2 | Every assessment | `balance = payable − allocated`, and `allocated = Σ applied allocations` |
| A3 | Every journal entry | `Σ DR = Σ CR` |
| A4 | Trial balance, every business date | Balances |
| A5 | Ledger vs sub-ledger | `2010` per agency = Σ unswept allocations per agency |
| A6 | Hash chain | Intact from genesis; tampering detected and located |
| A7 | Balance rebuild | Recomputed balances byte-identical to cached |
| A8 | Suspense accounts at period close | `1900` is zero |

Group B — **idempotency and concurrency**:

| # | Test | Assertion |
|---|---|---|
| B1 | Same `Idempotency-Key`, same body, twice | One effect, identical response, `X-Idempotent-Replay: true` |
| B2 | Same key, different body | 422, no effect |
| B3 | 50 concurrent identical requests | Exactly one payment created |
| B4 | Same `rail_e2e_id` twice | Second rejected as duplicate |
| B5 | Same STAN/RRN/acquirer/date twice | Second rejected |
| B6 | Concurrent allocations to one assessment | No over-allocation; balance never negative |
| B7 | Journal replay after a crash mid-apply | No double posting |

Group C — **exception paths**:

| # | Test | Assertion |
|---|---|---|
| C1 | Credit after intent expiry | Applied; `COMPLETED_LATE`; **not** rejected |
| C2 | Credit ≠ intent amount | Actual amount applied; residual handled per policy |
| C3 | Under-payment within tolerance | Settled; rounding relief posted; `Σ line items = assessed` still holds |
| C4 | Over-payment beyond tolerance | Surplus to `2030`; treated per `overpay_treatment` |
| C5 | Cheque returned after provisional credit | Full §14.6 cascade; balances exactly restored; surcharge resumes from the original due date |
| C6 | Reversal without original | Held as `PENDING_REVERSAL`; auto-paired on arrival |
| C7 | Recall of swept funds | Rejected with the correct `camt.029` reason |
| C8 | Assessment amended below amount paid | Overpayment recognised; refund created |
| C9 | Duplicate payment | Accepted then auto-refunded; never rejected |
| C10 | Payment with an unparseable narrative | Unapplied; break raised; money on the balance sheet |
| C11 | Two valid PSIDs in one narrative | Review queue; **never guesses** |
| C12 | Agency API down at resolution | `AGENCY_UNAVAILABLE`; no guessed amount |
| C13 | Capture times out | `UNCERTAIN`; payer not shown a failure; not re-debited |

Group D — **controls and security**:

| # | Test | Assertion |
|---|---|---|
| D1 | Maker approves own proposal | Rejected by the database, not just the UI |
| D2 | Adjustment above authority limit | Rejected |
| D3 | Posting into a closed period | Rejected |
| D4 | Agency A reads agency B's PSID | Denied by row-level security |
| D5 | Tampered `resolution_token` | Rejected |
| D6 | Refund beneficiary override without approval | Rejected |
| D7 | Sweep including provisional funds | Rejected |
| D8 | PII in logs | Automated scan finds none |

### 26.2 Property-based tests worth the effort

- **Allocation is conservative.** For any payment amount and any set of open assessments, `Σ allocations + unapplied = amount`, always, for all five waterfalls. Generate 10,000 random cases.
- **Waterfall is monotonic.** Paying more never reduces the amount allocated to any higher-priority line.
- **Checksums catch human error.** Every single-digit substitution and every adjacent transposition of every generated PSID is caught.
- **Reversal is a true inverse.** For any payment, `apply` then `reverse` restores every affected assessment balance, line-item balance, and status to its exact prior value.
- **Recon is idempotent.** Re-running a run on the same sources produces identical matches and identical breaks.
- **Value-date assignment is total and deterministic.** Every timestamp in a year maps to exactly one value date under a given calendar and rule version.

### 26.3 Chaos and failure injection

Use the sandbox's injectable failures: rail timeout mid-capture; rail confirms twice; switch reverses a payment that never arrived; bank statement arrives truncated; agency webhook endpoint returns 500 for six hours; database primary fails during an apply transaction; clock skew of five minutes on a channel; a settlement cycle file arrives with a wrong net.

For each, the platform must lose no money, misstate no balance, and leave a clear trail.

### 26.4 Demo-specific regression test

One end-to-end test that replays §24.4 steps 1–11 in order and asserts every stated figure. If the demo script and the code ever diverge, this test fails first. Run it in CI.

### 26.5 Forward-compatibility check (G2P)

Disbursement is out of scope but the design deliberately does not preclude it. A single test proves that: post an `OUTBOUND` payment through the same ledger with a reversed journal template and assert the trial balance still ties. If that passes, G2P is a phase, not a rewrite.

---

## 27. Open Questions and Items To Verify

Everything marked `[A]` in this document is collected here. **Seed these as rows in a `compliance_control` register with an owner and a due date** (§20.1). Presenting a clear, honest list of what must be confirmed is far more credible in front of a bank or a central bank than inventing a citation.

### 27.1 Scheme and rail specifics — confirm with SBP and 1LINK

| # | Question | Blocks |
|---|---|---|
| Q1 | Exact ISO 20022 message identifiers and versions Raast uses (`pacs.008`, `pacs.002`, `pacs.004`, `camt.056`, and specifically whether RtP uses `pain.013`/`pain.014`) | Rail adapter field mapping |
| Q2 | Raast RtP expiry windows, decline reason-code list, cancellation-request semantics, and whether partial acceptance is supported | RtP state machine details |
| Q3 | Whether a distinct Raast **P2G/government collections** module exists with its own rulebook, or whether P2G is served by P2M + RtP + bulk | Product positioning only — the architecture is safe either way |
| Q4 | Raast settlement cycle times and count per business day | Settlement cycle configuration, sweep scheduling |
| Q5 | Current Raast alias types supported in production (mobile only, or email/national ID live yet) | Alias resolution configuration |
| Q6 | Raast fee schedule as it now stands for government collections | Commercial model |
| Q7 | 1LINK 1BILL integration specification: exact message field names, ISO 8583 bitmap positions, response-code list, timeout values, certification requirements | Switch adapter — **cannot be built without this** |
| Q8 | 1LINK PSID/consumer-number format constraints: permitted lengths, prefixes, checksum algorithms | Reference scheme validation |
| Q9 | PayPak requirements for government collection, and 3-D Secure obligations for card-not-present | Card channel |
| Q10 | PRISM+ participation and message formats for high-value inbound tax payments and outbound sweeps | RTGS adapter |

### 27.2 Government and treasury — confirm with each agency and the treasury

| # | Question | Blocks |
|---|---|---|
| Q11 | Exact PSID formats, digit lengths and validity windows for FBR/PRAL, each provincial revenue authority, e-Stamping, and e-challan systems | Reference scheme configuration per agency |
| Q12 | Whether CPR issuance is the platform's responsibility or the agency's, and the required CPR content and format | Receipting |
| Q13 | Scroll file format, transmission channel, cut-off times, and acknowledgement format per treasury | Scroll serialiser per agency |
| Q14 | Government account structures — Consolidated Fund vs Public Account classification, and the treasury account each product's receipts must reach | Head mapping, sweep destinations |
| Q15 | Reconciliation protocol with the Accountant General / AGPR and the agency's own accounting system | Recon source D and E |
| Q16 | Refund authority and process per agency for revenue already remitted to the treasury | `funding_source` handling |
| Q17 | Statutory record-retention periods per collection type | Retention policy |
| Q18 | Evidentiary requirements for a digitally signed receipt and scroll under the Electronic Transactions Ordinance 2002 — confirm with counsel | Signing approach |
| Q18a | The statutory basis for payment finality and irrevocability under the Payment Systems and Electronic Fund Transfers Act 2007 — specifically at what point a P2G payment discharges the citizen's obligation, and how that interacts with `obligation_discharge_date` (§13.3) and with cheque dishonour (§14.6) | Value-date and finality logic; reversal policy |
| Q18b | Whether the treasury banking function and Consolidated Fund classification described in §4.4 is accurate for each agency in scope — the funds-flow narrative there is `[A]` in its entirety | Sweep destinations, scroll content |
| Q19 | Deposit classification and whether interest accrues to depositors on refundable deposits | Deposit accounting |
| Q20 | Revenue head effective-dating rules across fiscal years | Head versioning |

### 27.3 Regulatory — confirm against current SBP instruments

| # | Question |
|---|---|
| Q21 | Which authorisation the operator needs: PSO, PSP, EMI, or operating under a sponsor bank — and the current Rules for PSOs/PSPs |
| Q22 | The current SBP Technology Risk Management Framework circular reference and its control domains. **Do not quote a circular number until verified.** |
| Q23 | Outsourcing risk-management framework applicability if the platform is operated for a bank |
| Q24 | Current customer grievance-handling instructions, turnaround times, and complaint reporting |
| Q25 | AML/CFT and CDD applicability to bill-payment and third-party-payer activity; monitoring and STR obligations |
| Q26 | Data localisation, cross-border transfer, and key-residency requirements |
| Q27 | PSO/PSP periodic reporting formats and incident notification timelines |
| Q28 | Availability and RPO/RTO expectations SBP applies to a payment system operator |
| Q29 | PCI-DSS level applicable if card acceptance is in scope |
| Q30 | Whether recon breaks above a materiality threshold are regulator-reportable |

### 27.4 Commercial and operational — decide internally

| # | Question |
|---|---|
| Q31 | Fee model per agency and per channel; who bears it; whether provincial sales tax on services applies to the fee |
| Q32 | Chargeback liability allocation between operator and agency |
| Q33 | Client-money segregation arrangements for Shape A (collector of record) |
| Q34 | Unclaimed-funds policy: escalation timeline and escheatment destination |
| Q35 | Auto-write-off thresholds and approval authority limits |
| Q36 | Cut-off times per agency and per product; who may extend them and on what authority |
| Q37 | Sweep frequency per agency |
| Q38 | Reminder and notification caps — a government platform that spams citizens creates political problems |
| Q39 | Whether provisional credit on cheques is offered at all, and to which payer segments |
| Q40 | SLA and penalty regime offered to agencies |

### 27.5 Design decisions deliberately left open

| # | Decision | Recommendation |
|---|---|---|
| D1 | Modular monolith vs microservices | **Monolith for the demo and probably for launch** (§22.6). Ledger invariants need multi-table transactions; eventually-consistent money does not survive a hostile question. |
| D2 | Under-payment policy when partial is not allowed | Default `HOLD_AS_UNAPPLIED`; `REJECT_AND_RETURN` for service-gating products |
| D3 | Whether the platform mints all PSIDs or accepts agency references | Support both; prefer platform-minted for new products because of the Damm protection |
| D4 | Fuzzy-match auto-apply floor | Never below "Medium" confidence. Misapplied money is worse than late money. |
| D5 | Whether to build G2P disbursement | Not now; keep the ledger and rail abstraction G2P-ready (§26.5) |

---

## 28. Sources

Verified facts marked `[V]` in this document derive from the following. Items marked `[A]` are **not** sourced here and are collected in §27.

- [Raast — Pakistan's Instant Payment System, State Bank of Pakistan (Digital Financial Services)](https://www.sbp.org.pk/dfs/Raast.html) — Raast's purpose and positioning; end-to-end digital payments among individuals, businesses and government entities; cost-recovery design; interoperability and security objectives; the P2P and P2M module structure.
- [Case Study: Pakistan — RAAST, World Bank Fast Payments Toolkit (May 2022)](https://fastpayments.worldbank.org/sites/default/files/2022-05/Pakistan_RAAST_Case_Study_%20May_2022.pdf) — ISO 20022 as the messaging standard; 24×7×365 availability; clearing in Raast with settlement in PRISM on a deferred net settlement basis across multiple intraday cycles; the prefunded/collateralised debit-cap model guaranteeing settlement; the Centralised Addressing Scheme (CAS), Raast ID alias types, no-duplicates rule and alias expiry; the phased rollout (Phase 3 bulk/dividends January 2021, Phase 4 P2P with CAS and **Request to Pay** February 2022, Phase 5 P2M November 2022); participation model with banks and MFBs as Direct Members, **government entities as Special Members** and EMIs via a member; APIs for participants and designated government entities; QR support for the merchant use case; **no system-level transaction limits**, with limits set by participating institutions; free-to-end-user intent in early phases; MPLS VPN connectivity via two ISPs; channel coverage including branches and agents.
- [Raast, Wikipedia](https://en.wikipedia.org/wiki/Raast) — launch chronology (11 January 2021; P2P February 2022) and the Pakistan Faster Payment System designation.
- [State Bank of Pakistan — Digital Financial Services portal](https://www.sbp.org.pk/dfs/index.html) — PRISM+ as current infrastructure; the PSO/PSP, EMI and government-entity participant categories; the Laws & Regulations index.
- [SBP Payment Systems Review](https://www.sbp.org.pk/psd/pdf/PS-Review-Q4FY25.pdf) — Raast volume and value trends.

**Standards referenced by name** (design targets, not claims about any particular rail's implementation): ISO 20022 message catalogue (`pain.013`, `pain.014`, `pacs.008`, `pacs.002`, `pacs.004`, `pacs.028`, `camt.052`, `camt.053`, `camt.054`, `camt.056`, `camt.029`, `remt.001`); ISO 11649 structured creditor reference; ISO 7064 MOD-97-10; the Damm algorithm; EMVCo Merchant-Presented Mode QR tag structure and CRC-16/CCITT-FALSE; RFC 9457 Problem Details; RFC 2119 requirement levels.

### 28.1 A note on research completeness

Web search capacity was exhausted during the preparation of this document, and several primary sources — the 1LINK 1BILL integration specification, Raast participant documentation, and current SBP circulars — are not publicly retrievable in any case. Rather than fill those gaps with plausible-sounding detail, every unverified item is marked `[A]` and listed in §27 with the specific question that must be answered and what it blocks.

This is deliberate and it is the right posture for a document of this kind. A fabricated circular number is worse than an acknowledged gap: the gap costs one phone call, while the fabrication destroys the reader's trust in everything else on the page. The architecture is designed so that all remaining uncertainty lives in the rail adapters (§22.6), which means answers to §27 change adapter configuration and mapping tables — not the domain model, not the ledger, and not the reconciliation engine.
