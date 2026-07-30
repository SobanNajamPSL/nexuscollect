# AGENTS.md — NexusCollect P2G Collection Platform

Standing instructions for this repository. Read this before any task.

## What this is

A **demonstration build** of a Person-to-Government payment collection platform,
specified in full by `P2G-Collection-Platform-Design.md`. The demo will be
**screen-recorded and shown to a government agency**. That fact drives several
decisions below — read §"Demo mode" before writing any date logic.

## The spec is normative

`P2G-Collection-Platform-Design.md` (3,800 lines, 28 sections) is the single source
of truth. Section references in this file use its numbering.

- Read **§0** before your first task. Its eight hard rules in §0.2 are non-negotiable.
- Do not redesign what the spec already decides. If you believe the spec is wrong,
  say so and stop — do not silently deviate.
- If the spec is genuinely silent on something, choose the simplest option that
  satisfies §0.2, and note the choice in your response.

## The eight hard rules (§0.2), restated because they get violated

1. **Money is `bigint` minor units** (paisa). No `float`, `double`, `numeric` or
   `Decimal` for money — not in the database, not in TypeScript, not in JSON.
2. **The ledger is append-only.** No `UPDATE`/`DELETE` on `journal_entry` or
   `journal_line`. Enforce with database rules and write a test proving they fire.
3. **Balances are derived.** Cached columns must be rebuildable to byte-identical
   values from allocations.
4. **Every state-changing endpoint is idempotent** on `Idempotency-Key` (§17.4).
5. **Assessment, Payment and Allocation are three separate things** (§6.4). Never
   put authoritative payment state on the assessment.
6. **No channel logic in the core.** No `if (channel === 'QR')` outside an adapter.
7. **Reconciliation must find exactly the 11 planted breaks** in
   `demo-data/expected-results.json`.
8. **Two-sided time**: `value_date` (business, Asia/Karachi) and `created_at`
   (system, UTC) are different columns and are never conflated.

## Fixtures are assertions, not suggestions

`demo-data/expected-results.json` is a **test fixture**. Assert against it.

- Never edit it to make a test pass.
- Never re-run `scripts/generate_demo_data.py` to "fix" a failing assertion. If a
  number disagrees, the code is wrong until proven otherwise.
- If you are convinced the fixture is wrong, stop and tell me. Do not regenerate.

## Never fabricate

- **No invented regulatory citations.** Items marked `[A]` in the spec are
  unverified and must stay unverified. Do not add circular numbers, dates or
  regulation names that are not in §28 Sources. §27 is the register of open
  questions; add to it rather than inventing an answer.
- **No invented demo figures.** Every amount, PSID, reference and receipt number
  shown in the UI or in tests must come from `demo-data/`.

## Stack

Chosen for speed to a working, recordable demo. Do not substitute.

| Layer | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict mode |
| API | Fastify, generated against `api/openapi.yaml` |
| Database | PostgreSQL 16 |
| Query layer | **Kysely** — raw-SQL control. **No ORM for the ledger or allocation engine.** |
| Migrations | Plain `.sql` files in `db/migrations/`, applied in order |
| Tests | Vitest (unit + integration), Testcontainers for a real Postgres |
| UI | React + Vite + Tailwind, 6 screens only (see §"UI scope") |
| Local run | Docker Compose: `db`, `api`, `worker`, `web` |
| Money | `bigint` in Postgres, `bigint` in TypeScript. Never `number`. |

## Module layout

Mirror the twelve capabilities in §5. Boundaries must be visible and enforced —
a module may not import another module's internals, only its public interface.

```
src/
  modules/
    config/ obligation/ resolution/ initiation/ rtp/ instrument/
    ledger/ settlement/ recon/ evidence/ risk/ identity/
  adapters/rails/     raast/ onelink/ prism/ card/ wallet/ cash/ cheque/
  api/                v1/ switch/ admin/ public/ internal/
  platform/           idempotency/ outbox/ audit/ clock/ money/ checksum/
db/migrations/
test/                 unit/ integration/ fixtures/
web/                  the 6 demo screens
```

`platform/money` and `platform/checksum` come first — everything depends on them.

## Demo mode — read before writing any date logic

The demo dataset is anchored to **2026-07-30 (Asia/Karachi)**. Overdue statuses,
expiry windows, surcharge accrual and the live early-payment discount all key off
that date. If the application reads the real system clock, the recorded demo
degrades every day that passes.

Therefore:

- **All time comes from an injected `Clock` interface.** No `new Date()`, no
  `Date.now()`, no `now()` in SQL, anywhere in `src/`. Add a lint rule.
- `DEMO_MODE=true` pins the clock to `2026-07-30T12:00:00+05:00`.
- `POST /internal/demo/advance-clock` moves it, for showing surcharge accrual.
- `POST /internal/demo/reset` restores the database to seeded state in **under 10
  seconds**. A fumbled take must be re-recordable immediately.
- The demo must be **deterministic**: same actions, same numbers, same screens,
  every time. No randomness in anything the camera sees.

## UI scope — 6 screens, no more

Built to drive §24.4 end to end. Do not build the other nine screens from §22.1
until every phase gate has passed.

1. **Citizen payment** — resolve by any reference, see payables, pay, get receipt
2. **Receipt + public verification** — including offline QR verification
3. **Break register** — list, investigate, propose, approve (maker-checker, two users)
4. **Instrument register** — lodge, link, clear, return; the dishonour cascade
5. **Agency dashboard** — head-wise position, confirmed vs settled vs swept
6. **Control assertions** — the five §10.8 checks, live, with a "break the chain" button

Audience is a **government agency**, so polish in this order: correctness of
head-wise reporting → receipt quality (including Urdu) → the scroll → citizen
journey clarity. Do not spend time on ledger visualisations they will not ask about.

## Phase discipline

Work the phases in `PROMPTS.md`, in order. For each phase:

- Implement **only** that phase. Do not build ahead.
- Stop at the gate. Run the phase's acceptance criteria from §25 and show me the
  passing tests before moving on.
- If a criterion cannot pass, stop and explain why. Do not weaken the test.

## Things that will tempt you, and the answer

| Temptation | Answer |
|---|---|
| Use an ORM for the ledger | No. Raw SQL. The invariants depend on exact control. |
| Store money as `number` because `bigint` is awkward in JSON | No. Serialise as a string or a JSON number of minor units; never a decimal. |
| Make `assessment.paid_amount` the source of truth | No. §6.4 exists specifically to prevent this. |
| Skip the `UNCERTAIN` payment state | No. §9.4. It is the most important state in the platform. |
| Reject a late or mismatched credit | No. Always accept money that has left the payer's account (§8.4). |
| Regenerate the fixture to fix a test | No. See §"Fixtures are assertions". |
| Build all 15 back-office screens | No. Six, listed above. |
| Start on HSM key rotation, DR rehearsals or 3,000 TPS load tests | No. §19 and §20 are design commentary for this build, not backlog. Implement idempotency, audit and RBAC; stub the rest. |
| Add a regulatory citation to look thorough | Never. |
