# NexusCollect — P2G Collection Platform

A demonstration build of a bank-grade Person-to-Government payment collection
engine, anchored to Pakistan's rails (Raast, 1LINK, PRISM+) with a rail-agnostic
abstraction layer.

## What is here

| Path | What it is |
|---|---|
| `P2G-Collection-Platform-Design.md` | **The specification.** 28 sections, normative. The only document you need to read. |
| `CLAUDE.md` | Standing instructions for the coding agent. Stack, hard rules, demo-mode requirements. |
| `PROMPTS.md` | Eight phase prompts to paste into Claude Code, one at a time. |
| `api/openapi.yaml` | OpenAPI 3.1 contract. 48 paths across six API surfaces, 5 webhooks. Validated. |
| `demo-data/` | 22-file seed dataset **and** the test fixture. See its own README. |
| `scripts/generate_demo_data.py` | Regenerates `demo-data/`. Deterministic, 17 self-checks. |

## Getting started

```bash
git init && git add . && git commit -m "Spec, contract and demo data"
claude          # then paste Prompt 0 from PROMPTS.md
```

Work `PROMPTS.md` in order. Each prompt ends at a gate; do not advance until it
passes. A **recordable demo exists after Prompt 4** — film then, and keep building.

## The three ideas that matter

If you read nothing else in the spec, read these.

**Assessment / Payment / Allocation are three separate entities** (§6.4). A single
many-to-many allocation table handles partial payments, overpayments,
one-payment-many-bills, revenue-head splitting and cheque reversal through one code
path. Putting `paid_amount` on the bill handles none of them.

**`value_date` and `obligation_discharge_date` are different dates** (§13.3). The
rail runs 24×7; the government's accounting day does not; tax deadlines are legal
dates. Conflating them either misstates the bank position or penalises citizens who
paid on time.

**`UNCERTAIN` is a first-class payment state** (§9.4). A capture can time out with
the money already gone. Most designs omit this state and lose money to it.

## Verifying the build without reading the code

Four checks, in order of value:

1. **`GET /internal/control/*`** — the five reperformance assertions from §10.8.
   Trial balance ties, allocations reconcile, balances rebuild identically,
   sub-ledger agrees, hash chain intact. All five green is a strong signal.
2. **Reconciliation finds exactly 11 breaks** for 2026-07-30, matching
   `demo-data/expected-results.json`. Not 10, not 12. This is very hard to fake.
3. **Tamper with a `journal_line` row, then run `verify-chain`.** It should name the
   entry. Takes twenty seconds and proves the ledger is real.
4. **Return instrument `IN-0004`** and watch the cascade: 6 allocations reversed,
   3 assessments un-settled, 3 receipts voided, surcharge resuming from the original
   due date, dishonour charge raised automatically.

## Demo mode

The dataset is anchored to **2026-07-30 (Asia/Karachi)**. Overdue statuses, expiry
windows and the live early-payment discount all key off that date, so the
application must run on an injected clock, not the system clock.

```bash
DEMO_MODE=true                          # pins the clock to 2026-07-30T12:00:00+05:00
POST /internal/demo/reset               # seeded state in under 10 seconds
POST /internal/demo/advance-clock       # to show surcharge accruing
```

Reset before every take. The demo must be deterministic: same actions, same
numbers, same screens, every time.

## The demo script

§24.4 is an eleven-step walkthrough with a real anchor in the data at every step.
The opening is the strongest: resolve `LEA-17-1000` and get back three live
payables across two agencies, one carrying an active discount, plus a fourth
returned as already settled with its receipt attached.

## What this build deliberately does not do

- **Compute assessments.** Agencies compute what is owed; the platform collects it.
  Derived amounts (surcharge, discount, rounding) are in scope.
- **Touch a card PAN.** Hosted fields or redirect only, which keeps the platform out
  of PCI-DSS scope. Worth saying out loud in the demo.
- **G2P disbursement.** Out of scope, but the ledger and rail abstraction are built
  so it is an additive phase rather than a rewrite (§26.5).
- **HSM key rotation, DR failover automation, 3,000 TPS load testing.** §19 and §20
  are design commentary for this build, deferred deliberately.

## Before any production conversation

§27 lists **43 numbered open questions** — scheme specifics to confirm with SBP and
1LINK, government funds-flow and scroll formats to confirm per agency, and the
regulatory perimeter to confirm against current SBP instruments.

Nothing unverified is asserted as fact anywhere in the spec: `[V]` markers trace to
a source in §28, and `[A]` markers are unverified by construction. **Do not let the
build invent a circular number to fill a gap.** An acknowledged gap costs one phone
call; a fabricated citation costs the reader's trust in everything else.
