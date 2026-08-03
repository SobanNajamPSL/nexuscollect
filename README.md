# NexusCollect — P2G Collection Platform

A demonstration build of a bank-grade Person-to-Government payment collection
engine, anchored to Pakistan's rails (Raast, 1LINK, PRISM+) with a rail-agnostic
abstraction layer.

## What is here

| Path | What it is |
|---|---|
| `spec/` | **The normative contract.** `P2G-Collection-Platform-Design.md` — 28 sections, cited by number throughout the code — and `openapi.yaml`, the OpenAPI 3.1 surface. |
| `src/` | The platform: twelve capability modules, rail adapters, five API surfaces, platform primitives. |
| `web/` | Four portals — `citizen/`, `agency/`, `ops/`, `field/` — plus `shared/`, which holds the demonstration harness. |
| `db/migrations/` | Plain `.sql`, applied in order. |
| `test/` | Vitest, against a real Postgres via Testcontainers. |
| `scripts/` | Migrate, seed, capture every screen, record the demonstration, build its narration. |
| `demo-data/` + `config/` | Seed dataset **and** the test fixture. Read-only — never regenerated to make a test pass. Siblings by necessity: the loader resolves `config/` relative to `demo-data/`. |
| `docs/` | [Manual](docs/manual/), [demonstration](docs/demo/), [runbooks](docs/runbooks/). Start with `docs/manual/`. |
| `archive/` | The phase prompts, the original UI brief, the reference prototype. Provenance only — nothing there is current, and [its README says why](archive/README.md). |
| `CLAUDE.md` | Standing instructions for the coding agent. Stack, hard rules, demo-mode requirements. `AGENTS.md` points here. |

## Running it

```bash
docker compose up -d db
npm install
npm run migrate && npm run seed
npm run dev                    # the API, on :3000
```

Then start whichever portals you need. Each is a separate Vite app on its own
`*.localhost` hostname — Chrome resolves those to loopback on its own, so there is
nothing to add to `/etc/hosts`:

```bash
npm --prefix web run dev:citizen   # pay.localhost:5174
npm --prefix web run dev:agency    # agency.localhost:5175
npm --prefix web run dev:ops       # ops.localhost:5176
npm --prefix web run dev:field     # field.localhost:5177
```

| Portal | Who it is for |
|---|---|
| **Citizen** `pay.localhost:5174` | The public. No sign-in, phone-first. Find a bill by any reference, pay it, get a receipt in English or Urdu. |
| **Agency** `agency.localhost:5175` | One agency's finance staff. Head-wise position with confirmed, settled and swept as three separate numbers. |
| **Operator** `ops.localhost:5176` | The cross-agency back office. Nineteen screens: queues, reconciliation, exceptions, sweep, assurance. |
| **Field** `field.localhost:5177` | A counter or a shop. Cash, cheque lodgement, till close, agent float. |

A visibly-labelled **demonstration harness** bar above every portal carries the
persona switcher, the portal switcher, the demo clock, reset, and a button that
deliberately corrupts the ledger. None of it is part of the product;
[`docs/manual/01-demonstration-harness.md`](docs/manual/01-demonstration-harness.md)
explains why it sits outside rather than inside.

To check the whole thing still works, including every screen:

```bash
npm test && npx tsx scripts/capture-screens.ts
```

The capture script walks all 35 screens across the four portals and fails on any
console error, failed request or missing data — so it is the route sweep as well as
the source of the manual's screenshots.

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
