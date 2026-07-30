# UI Brief — NexusCollect Citizen & Ops Screens

*Prepared for handoff to Claude Design. Content and figures below are drawn directly from `P2G-Collection-Platform-Design.md` and `demo-data/` — no invented amounts, references, or citations. Items marked **[TO CONFIRM]** are design defaults proposed here, not facts from the spec — override any before this goes to Claude Design.*

## 1. What this is

A demonstration build of a Person-to-Government (P2G) payment collection platform, screen-recorded for a government agency audience. Six screens only, in this build (per `CLAUDE.md`); a further nine back-office screens exist in the spec (§22.1) but are explicitly out of scope until later phases — don't design them yet.

## 2. Audience & tone

Government agency reviewers first, citizens second. Priority order for design effort, straight from `CLAUDE.md`:

1. Correctness of head-wise reporting (numbers must read as trustworthy, not just tidy)
2. Receipt quality — including Urdu
3. "The scroll" (a financial hand-off document to treasury)
4. Citizen journey clarity
5. *Not* ledger visualisations — the spec explicitly says don't spend time there

Tone: plain, official, no marketing gloss. This is closer to a tax portal or e-Challan system than a consumer fintech app.

## 3. Design defaults to confirm **[TO CONFIRM]**

The spec never states these — proposed defaults so Claude Design isn't blocked:

| Question | Proposed default | Why |
|---|---|---|
| Citizen screens: device target | Mobile-first responsive | §3.1: citizens reach the portal alongside bank apps/ATMs/agents — likely on a phone |
| Ops/teller/agency screens: device target | Desktop, dense data tables | These are workstation tools for internal roles (§3.2) |
| Accessibility | WCAG 2.1 AA | No level stated in spec; AA is the standard baseline for a government-facing product |
| Brand / logo / palette | None exists — clean, neutral, "official" | Spec names no brand for NexusCollect or a house style for agencies |
| Dark mode | Not required | Not mentioned; back-office is desk-based daytime ops work |
| Urdu font/RTL | Must render correctly right-to-left | Explicitly required (§16.1) — not optional |

## 4. The six screens

### Screen 1 — Citizen Payment
**Who:** citizen payer, no login required (reference-based lookup). **Function:** resolve a bill by any reference, see all payables, pay, get a receipt.

Key content:
- Resolve-by-reference input, accepting any of the reference types the platform supports (PSID, vehicle reg, CNIC, NTN, case no., etc. — §7.5)
- Result: a list of open payables *and* any already-settled ones (must show `ALREADY_SETTLED` with the existing receipt attached, not an error)
- Per-payable: agency name, product/description, amount due, due date/status, any live early-payment discount called out distinctly
- Pay action → amount confirmation (must show if a surcharge will make the printed amount stale — "amount valid until X, after that pay Y") → receipt

**Real anchor to design against** (`VEHICLE_REG = LEA-17-1000`):

| PSID | Product | Amount (PKR) | Status |
|---|---|---|---|
| 31010900000181526 | ETPB Motor Vehicle Token Tax 2026-27 | 10,000.00 | OVERDUE |
| 41011300000190123 | PSCA e-Challan, moving violation | 3,750.00 | ISSUED — 1,250.00 early discount live |
| 41011400000286611 | PSCA e-Challan, parking | 3,000.00 | OVERDUE |
| 41011400001606295 | PSCA e-Challan, parking (Jan) | — | **SETTLED** → returns existing receipt |

Design must handle: one lookup returning payables across **two different agencies** in one list, one carrying a live discount, one already paid.

States to design: empty (no reference entered), not-found, bad-checksum (`INVALID_REFERENCE_CHECKSUM` — reject before any lookup, so this should feel instant), loading, success (mixed open/settled), payment-in-flight, `UNCERTAIN` (payment captured but not yet confirmed — **never shown as a failure**, needs its own calm, non-alarming state), success/receipt.

### Screen 2 — Receipt + Public Verification
**Who:** citizen (own copy), anyone with a receipt (verification, no login).

Receipt content, exactly per §16.1 — design every one of these fields, nothing invented:
> Agency name and logo · receipt no · payment reference · PSID · payer name and masked ID · head-wise breakdown · amount in figures **and words** · fee shown separately · channel · rail · value date · obligation discharge date · teller/branch where applicable · instrument details · QR verify code · "This is a system-generated receipt"

Must support English and Urdu, RTL-correct, and a **provisional variant**: a receipt for an uncleared cheque must be visibly marked `PROVISIONAL — subject to realisation of instrument` — this needs to be unmistakable, not a small badge.

Public verification (`/verify/{code}`): a minimal public page — agency, receipt number, amount, date, status (`VALID | VOIDED | REFUNDED`), masked payer name only. Include the demo's signature moment: scan QR → verify with no network → alter one digit → fails visibly.

### Screen 3 — Break Register
**Who:** two internal roles — `OPS_RECON_ANALYST` (proposes) and `OPS_RECON_APPROVER` (approves); same person can never do both (maker-checker, enforced at the data layer too).

Function: list reconciliation breaks, investigate one, propose a resolution, approve/reject it as the other user.

**Real anchor** — the 11 planted breaks for 2026-07-30, total unexplained PKR 890,949.50:

| Code | Type | PKR | Auto-resolvable |
|---|---|---|---|
| B01 | Unmatched bank credit (narrative-resolvable) | 47,500.00 | no |
| B01 | Unmatched bank credit (unresolvable) | 125,000.00 | no |
| B02 | Unmatched platform payment | 447,552.00 | no |
| B03 | Amount mismatch (fee deducted at source) | 50.00 | no |
| B04 | Duplicate switch-file row | 120,340.00 | yes |
| B05 | Timing difference | 3,500.00 | yes |
| B05 | Timing difference | 3,000.00 | yes |
| B06 | Unapplied receipt aged 14 days | 125,000.00 | no |
| B07 | Fee variance vs contracted rate | 7.50 | no |
| B08 | Raast cycle net below constituents | 12,500.00 | no |
| B09 | Scroll line rejected by treasury | 6,500.00 | no |

Design nuance: auto-resolved breaks (B04, B05×2) should read as *resolved*, not alarming — they must not look like open alarms in the register. B09 should read as a *classification* issue ("money's already banked, just misfiled"), not a cash-missing alarm — visually distinguish break *types*, not just severity.

States: list/filter, break detail (source refs, amounts, suggested match), propose form, approve/reject as a second user, resolved/aged states, SLA-aging indicator.

### Screen 4 — Instrument Register
**Who:** ops/teller. Function: lodge, link, clear, return a physical instrument (cheque, pay order, demand draft, cash); show the dishonour cascade when a cheque bounces.

**Real anchor** — `IN-0004`, cheque no. `004822`, PKR 644,112.00, returned for insufficient funds. Design the cascade as a visible, steppable sequence, not a silent status flip:
- 6 allocations reversed
- 3 assessments un-settled (`12010400001661551`, `12010400001776532`, `12010400001899869`)
- 3 receipts voided (shown as voided, never deleted — link back to the original)
- Surcharge resumes from the **original** due date (no holiday for the time it sat as provisional)
- Service gate re-closed
- A new dishonour-charge assessment (`12010600005120245`) raised automatically

This is one of the demo's two signature moments — design it so a reviewer can watch one action (return the instrument) ripple through six downstream effects and *see* each one land.

### Screen 5 — Agency Dashboard
**Who:** `AGENCY_ADMIN` / finance officer. Function: head-wise position — confirmed vs settled vs swept, as three genuinely separate figures (§13.1), never merged into one "collected" number.

**Real anchor** — multi-head split, payment `P260000E`, PKR 943,880.00 in one internet-banking transaction:

| Revenue head | Amount (PKR) |
|---|---|
| B01101 Income Tax on Companies | 920,000.00 |
| B02388 Default Surcharge | 12,880.00 |
| B02391 Penalty | 11,000.00 |

Also design against the pack's headline control totals (useful for the dashboard's summary row): Assessed 27,610,165.00 · Payable (after discounts) 27,608,915.00 · Allocated 23,206,523.00 · Outstanding 4,402,392.00.

This is the screen the spec cares most about ("one good scroll is worth ten screens") — prioritise legible, defensible head-wise tables over any chart.

### Screen 6 — Control Assertions
**Who:** ops/engineering, but this is the demo's trust-building moment for the whole audience. Function: the five reperformance checks, live, with a "break the chain" button.

The five checks (§10.8), each needs a clear pass/fail state:
1. Trial balance ties (`Σ debits = Σ credits`)
2. Allocation integrity (`Σ applied allocations + unapplied = gross`, for live payments)
3. Balance rebuild (recomputed values byte-identical to cached)
4. Ledger vs sub-ledger (agency payable balance = Σ unswept allocations)
5. Hash-chain intact (`verify-chain`)

Design both directions explicitly: all-green state, and the deliberate failure — the demo tampers with a ledger row live, then `verify-chain` must **name the specific tampered entry**, not just show a generic red X. That specificity is the point of the whole screen.

## 5. Cross-cutting requirements (apply to all six screens)

- **Money display:** all amounts are stored as integer minor units (paisa); every screen displays PKR with two decimal places, formatted from the integer — never a float in transit.
- **Two languages, RTL where Urdu is shown** (receipt is the hard requirement; consider whether the citizen payment screen also needs a language toggle).
- **Demo-mode awareness:** the whole app runs on a fixed injected clock (2026-07-30T12:00:00+05:00 by default) with a visible way to advance it (to show surcharge accruing) and a reset control that must feel instant (<10s) — this likely wants a small persistent "demo clock" indicator somewhere, so it doesn't look like the app is silently drifting.
- **Idempotent submits:** pay/lodge/approve actions must be safe to double-click — disable-on-submit or optimistic-lock patterns, since a retried request must never look like it created a second effect.
- **Latency budgets that affect loading-state design:** resolve p99 ≤ 300ms, payment apply p99 ≤ 800ms, receipt issue p99 ≤ 3s. Design lightweight loading states for the first two, and make sure the receipt screen doesn't feel like it's hanging at 2–3 seconds.

## 6. Explicitly out of scope for this design pass

- The other nine back-office screens from §22.1 (payment 360° view, payer 360° view, unapplied-receipts queue, `UNCERTAIN` queue, teller till, settlement & sweep, approvals inbox, agency/product config, recon run console, report centre, audit explorer)
- Any ledger visualisation (explicitly de-prioritised by the spec)
- Card entry fields of any kind — card payments are hosted-field/redirect only; the platform never sees a PAN, and the UI must not imply otherwise
