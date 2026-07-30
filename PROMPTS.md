# Phase prompts for Claude Code

Paste these one at a time. **Do not combine them.** Wait for each gate to pass.

The build is sequenced so a **recordable demo exists after Prompt 4**. Film then;
Prompts 5–8 add the rest without putting the recording at risk.

Before Prompt 0, confirm the repo has: `CLAUDE.md`, `P2G-Collection-Platform-Design.md`,
`api/openapi.yaml`, `demo-data/`, `scripts/generate_demo_data.py`.

---

## Prompt 0 — Foundations

```
Read CLAUDE.md, then P2G-Collection-Platform-Design.md sections 0, 6, 7, 10 and 23.

Implement Phase 0 from section 25 only. Nothing else. Do not build any API
endpoint, any UI, or any business logic beyond what Phase 0 lists.

Deliver:
- Docker Compose with db + api skeleton
- Every table, constraint, index, trigger and rule from section 23, as ordered .sql
  migrations, including row-level security from 23.1
- platform/money  (bigint minor units, parse/format/serialise, no floats)
- platform/checksum (Damm, Luhn, ISO 7064 MOD-97-10, ISO 11649 RF encode/validate)
- platform/clock  (injected Clock; DEMO_MODE pins to 2026-07-30T12:00:00+05:00)
- platform/idempotency (section 17.4 semantics exactly)
- platform/audit  (hash-chained), platform/outbox (transactional)
- A loader that seeds every file in demo-data/ into the database

Then prove Phase 0 with tests I can see:
1. Damm catches every single-digit substitution AND every adjacent transposition
   across 10,000 random PSIDs
2. UPDATE and DELETE on journal_entry and journal_line are no-ops
3. An unbalanced journal entry raises at COMMIT, not at INSERT
4. Tampering with a journal row is detected by verify-chain, which names the entry
5. Idempotency: replay returns the stored status and body; different body = 422;
   50 concurrent identical requests create exactly one record
6. Agency A cannot read agency B's assessment even with a valid PSID
7. No money column anywhere is float/double/numeric/Decimal
8. A lint rule fails the build on new Date() or Date.now() inside src/
9. All 22 files in demo-data/ load, and all eight generator assertions still hold
   against the loaded DATABASE (not the CSVs)

Stop when all nine pass. Show me the test output. Do not start Phase 1.
```

---

## Prompt 1 — Obligation + Resolution

```
Read P2G-Collection-Platform-Design.md sections 2, 6, 7, 8.1, 8.2 and 15.4.

Implement Phase 1 from section 25 only.

Key requirements:
- resolution_index maintained via trigger or outbox on every assessment write
- POST /v1/resolve accepting all 17 key types from 7.5, with privacy shaping
- Offline checksum validation BEFORE any database hit
- Derived amounts recomputed to the clock's today: surcharge, early discount,
  rounding (15.4). compute_derived must be deterministic and versioned.
- resolution_token: signed, 5-minute, binds amounts to the payable set
- ALREADY_SETTLED returns the existing receipt, per 8.2
- Assessment create / amend (new version, same PSID) / cancel, with the guard that
  a paid assessment cannot be cancelled

Gate:
- Resolve VEHICLE_REG "LEA-17-1000" returns exactly the 3 open payables and the 1
  ALREADY_SETTLED item in demo-data/expected-results.json, with the stated amounts
  and the live 1,250.00 discount
- Bad check digit returns INVALID_REFERENCE_CHECKSUM with zero database queries
- Identity-keyed lookup without step-up returns 401
- p99 of POST /v1/resolve is under 300 ms against the seeded dataset
- Amending an assessment keeps the PSID and creates version 2

Stop at the gate. Show me the resolve response for LEA-17-1000 verbatim.
```

---

## Prompt 2 — Payment capture and cash application

```
Read P2G-Collection-Platform-Design.md sections 8.4, 9, 10 and 11.

Implement Phase 2 from section 25 only.

This is the core of the platform. Specific demands:
- The apply pipeline exactly as 11.1, all eight steps, idempotent and replayable
- Allocation engine implementing all five waterfalls, including true PRO_RATA with
  largest-remainder distribution so no paisa is lost
- Rounding relief posted as a ROUNDING line item so line items still sum to assessed
- All 30 journal templates from 10.6, each with a golden-file test
- Every payment stores application_trace explaining what matched and why
- The UNCERTAIN state and its resolver (9.4). UNCERTAIN is never shown as a failure.
- Late and mismatched credits are ACCEPTED, never rejected (8.4)
- Duplicate detection, all three tiers (14.5)
- Receipt numbering: gapless per agency per day, from a database sequence
- All five control assertions from 10.8 as endpoints

Gate:
- Payment P260000E splits across B01101 920,000.00 / B02388 12,880.00 /
  B02391 11,000.00 exactly
- For every live payment: applied allocations + unapplied = gross
- Trial balance ties on every business date in the dataset
- Balance rebuild produces byte-identical values to the cached columns
- The narrative-parsing corpus in 24.5 produces all seven stated outcomes
- Apply pipeline p99 under 800 ms

Stop at the gate. Show me the five control assertions passing.
```

---

## Prompt 3 — Reconciliation, cheques, QR, RtP

```
Read P2G-Collection-Platform-Design.md sections 4.5, 8.3, 8.5, 8.6, 8.8, 12 and 14.6.

Implement, in this order:
(a) the reconciliation engine from section 12 in full
(b) instrument lodgement, linking and the complete dishonour cascade (8.8, 14.6)
(c) EMVCo QR encode/decode with CRC-16/CCITT-FALSE (8.5)
(d) Request to Pay, full state machine from 9.2 (8.3)
(e) the switch four-message biller contract (8.6), including reversal-without-original

Non-negotiable gate — this is the one a reviewer will test:
- Ingest bank_statement_camt053.csv, switch_settlement_1link.csv and
  rail_settlement_raast.csv for business date 2026-07-30
- The engine reports EXACTLY 11 breaks, with the codes, amounts and source refs in
  demo-data/expected-results.json. Not 10, not 12.
- B04 and both B05 rows auto-resolve. B05 raises no alarm.
- B08 produces ONE cycle variance break, not one per transaction
- B09 is classified as a classification break, not a cash break
- A file whose control total disagrees with what was parsed FAILS the run
- The same file hash cannot be ingested twice
- Re-running the run produces identical matches and identical breaks

Then the cheque gate:
- Returning instrument IN-0004 reverses exactly 6 allocations, un-settles the 3
  stated PSIDs, voids 3 receipts, re-closes the service gate, resumes surcharge
  from the ORIGINAL due date, and raises dishonour PSID 12010600005120245
- All four QR payloads round-trip; the corrupted one is rejected QR_CRC_INVALID

Stop at the gate. Show me the break register for 2026-07-30.
```

---

## Prompt 4 — The 6 demo screens, and make it recordable

```
Read P2G-Collection-Platform-Design.md section 24.4 and the "UI scope" and
"Demo mode" sections of CLAUDE.md.

Build the six screens listed in CLAUDE.md, and nothing else. React + Vite +
Tailwind. Audience is a government agency: prioritise clarity and correctness of
head-wise figures over visual flourish. Receipts must render correctly in English
and Urdu, RTL-correct.

Also build:
- POST /internal/demo/reset — restores seeded state in under 10 seconds
- POST /internal/demo/advance-clock — for demonstrating surcharge accrual
- A "break the hash chain" button on the control screen that tampers with a
  journal row so verify-chain can catch it live

Gate — walk section 24.4 steps 1 to 11 in the UI, in order, and confirm every
figure on screen matches demo-data/expected-results.json. Then:
- Run reset, walk it again, and confirm every screen is identical
- Confirm no screen reads the real system clock

Stop here and tell me it is ready to record. Do not start Phase 3 of section 25.
```

**Record the demo at this point.** Then continue.

---

## Prompt 5 — Settlement, treasury, period close

```
Read P2G-Collection-Platform-Design.md section 13.

Implement Phase 4 of section 25 that is not already done: settlement cycles, DNS
netting, value-date and cut-off assignment, sweep, scroll generation, treasury
acknowledgement, period close.

Specific demands:
- Confirmed, settled and swept are three separate states, separately reported (13.1)
- value_date and obligation_discharge_date are both stored, with the rule version
  that produced them (13.3)
- A scroll is one line per ALLOCATION, not per payment
- A scroll that does not tie to the ledger is never emitted
- Provisional funds are excluded from sweeps — enforce PROVISIONAL_FUNDS_NOT_SWEEPABLE
- Posting into a closed period is rejected; reopening is impossible

Gate:
- The generated FBR scroll for 2026-07-30 ties to demo-data/scroll-sample.txt:
  same line count, same control total, same per-head subtotals, same detail hash
- The fiscal-year-boundary audit report lists everything within 2 hours of midnight
- Period close is blocked while any CRITICAL or HIGH break is open

Stop at the gate.
```

---

## Prompt 6 — Exceptions and remaining channels

```
Read P2G-Collection-Platform-Design.md sections 8.9 through 8.14, and section 14.

Implement Phase 5 of section 25: refunds, reversal cascade including the post-sweep
recovery item, recall handling, disputes and chargebacks, assessment amended
downward, refundable deposits, plus the remaining channels — card and wallet
(no PAN ever touches the platform), mandates, bulk file, third-party payer,
print-and-pay challan PDF.

Specific demands:
- Refund beneficiary defaults to the original debit account; override needs approval
- surplus_only refunds leave allocations untouched; the other path reverses them
- Deposits credit 2040, never 2010, and refund is the happy path
- Once swept, a reversal creates a receivable from the agency, not a silent undo
- Submitting demo-data/bulk_payment_input.csv rejects the WHOLE file because row 13
  references an already-settled PSID

Gate: every Group C test in section 26.1 passes.
```

---

## Prompt 7 — Hardening and the rest of the back office

```
Read P2G-Collection-Platform-Design.md sections 16, 18, 20, 21 and 22.

Finish: notifications with quiet hours and caps, receipt signing and offline
verification, the public verification endpoint, webhooks with the retry schedule
and signature scheme, the remaining nine back-office screens from 22.1, reports
R01-R18, and the twelve runbooks from 22.2 as markdown.

Then the full test battery from section 26: all 36 tests in 26.1, the six
property-based tests in 26.2, and the chaos scenarios in 26.3.

Do NOT implement: HSM key rotation, DR failover automation, or the 3,000 TPS load
test. Document them as deferred with a pointer to section 19.

Gate: all 36 tests green, all six property tests green, and the section 26.4
end-to-end regression that replays the 24.4 demo script and asserts every figure.
```

---

## If the agent goes off the rails

| Symptom | Say this |
|---|---|
| Building ahead of the phase | "Stop. You are in Phase N. Revert anything outside it." |
| A test was weakened to pass | "Restore the original assertion and fix the code instead." |
| The fixture was edited or regenerated | "Revert demo-data/. The fixture is authoritative. Fix the code." |
| Money appeared as a float | "Find every non-bigint money value and fix it. Then add a test that fails on reintroduction." |
| A circular number appeared | "Remove it. That claim is [A] in the spec. Add it to section 27 instead." |
| `new Date()` crept in | "Route it through platform/clock and make the lint rule catch this case." |
| Drifting from the spec | "Quote the section you are implementing, then explain the deviation. If you cannot cite it, revert." |
