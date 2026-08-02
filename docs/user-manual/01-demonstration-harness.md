# 1. The demonstration harness

Every portal has a dark bar across the top of it, labelled **DEMONSTRATION
HARNESS**:

![The harness bar above the operator portal](images/ops-01-today.png)

Nothing in that bar is part of the product. It exists so that one person at a
keyboard can drive a demonstration that would otherwise need four people in three
buildings, and it is visibly separated from the portal beneath it so nobody
mistakes one for the other.

It is worth being direct about why this is a harness rather than a login screen.
Real authentication is deliberately not built yet: the portals came first, the
identity system comes later. But the honest reason the controls live *outside* the
portals is stronger than that. None of them belong to a real user — least of all a
button whose entire purpose is to corrupt the financial ledger. Putting them in a
labelled strip above the product is the truthful place for them, and on camera it
makes the tamper demonstration *better*, not worse: you reach in from outside the
system and watch the system catch you.

---

## Acting as someone

The **Acting as** dropdown chooses which of the platform's real users you are. It
lists actual rows from `platform_user`, with their actual roles, and every request
the portal makes afterwards carries that user's identity — so the role checks you
see enforced are the real ones, not a simulation.

The users available are the ten seeded in `db/migrations/0028` plus a second agency
administrator added in `0030`:

| Person | Role | Agency |
|---|---|---|
| Bilal Farooq | Agency administrator | ETPB |
| Hina Jamil | Agency administrator | ETPB |
| Sana Malik | Agency operator | ETPB |
| Imran Qureshi | Reconciliation analyst | — |
| Ayesha Riaz | Reconciliation approver | — |
| Usman Tariq | Refund maker | — |
| Farah Sheikh | Refund approver | — |
| Nadia Aslam | Teller | — |
| Kamran Butt | Branch supervisor | — |
| Tariq Mehmood | Auditor | — |
| Zara Hussain | Support agent | — |

Two of these pairs exist for a specific reason. **Imran Qureshi and Ayesha Riaz**
are the maker and the checker for reconciliation breaks; **Usman Tariq and Farah
Sheikh** are the same for refunds. There are two agency administrators because a
single one would leave the agency's own maker-checker approvals with nobody to
approve them — a dead end that only becomes obvious when you try to use it.

### The persona list changes with the portal

Each portal offers only the people who belong in it. The field portal lists the
teller and the branch supervisor; the agency portal lists that agency's own staff;
the operator portal lists the seven back-office roles. The citizen portal lists
**nobody at all**, and says so:

> *No sign-in — this portal is public*

That is not an omission. A citizen finds a bill with a reference and a check
digit, never with an account, and a persona switcher on that portal would
misrepresent how the thing works.

`SERVICE_CHANNEL` — the twelfth role in the specification — has no persona either,
because it is a machine identity used by a bank's own systems calling the
institution API. It has no screens to appear in.

---

## Moving between portals

`Citizen · Agency · Operator · Field` in the harness bar are ordinary links to the
four addresses. They are how the demonstration walks a single day's money from the
payer, through the counter, into the agency's position, and out to treasury —
without ever pretending one person sees all of it.

Because each portal offers its own personas, moving between them also changes who
you can be. You navigate to a portal and *become* somebody who belongs there. You
are never someone who doesn't belong where you're looking.

---

## The demo clock

> **Demo clock 2026-07-30 12:00 PKT**

The platform never reads the machine's clock for any business decision. Every
date-sensitive calculation — is this bill overdue, is the discount still live, has
a cheque cleared, which business date does this payment count against — comes from
a single injected clock, and in the demonstration that clock is pinned to
**30 July 2026, 12:00, Asia/Karachi**.

This is why the walkthrough produces identical figures today, next week, or in a
year. It is also why the readout is in the harness bar and not tucked in a corner:
if the clock moves, everything derived from it moves, and the viewer should be able
to see the cause.

There is a small implementation detail worth knowing if you read the code: there is
no endpoint that *reads* the clock, so the portals read it by advancing it by zero.

### +1 day

**+1 day** advances the clock. Its purpose in the demonstration is surcharge
accrual: advance the clock and an overdue bill's payable amount grows, visibly, on
the citizen portal and in the agency's position, because the surcharge rule is
evaluated live against the new date rather than read from a stored figure.

Advancing the clock does not fabricate anything. It moves the date the rules are
evaluated against, and the rules do the rest.

---

## Reset

**Reset** restores the database to its seeded state. It is required to complete in
under ten seconds, and it does, because a fumbled take has to be re-recordable
immediately rather than after a coffee.

Reset is genuinely a restore, not an undo. Everything the demonstration created —
payments, receipts, minted bills, lodged cheques, resolved breaks, journal entries
— is gone, and the seeded data is back exactly as it was. That includes the demo
users themselves: truncating the agency table cascades through
`platform_user`, so reset re-seeds the users and their roles as its final step.
(This was a real bug once. The user list came back empty and every role check
started refusing everything, which is a memorable way to discover a foreign key.)

Two habits worth keeping:

- **Reset before every take.** Identical starting state, identical numbers.
- **Reset after a rehearsal.** The screenshots and figures in this manual assume
  seeded state; a half-finished rehearsal will not match them.

---

## Break the chain

The red **Break the chain** button deliberately tampers with a row in the
financial ledger.

It is the one control in the harness that alters data rather than the clock, and
its whole point is what happens next. Go to the operator portal's **Control
assertions** screen and re-run the checks: the hash-chain verification fails, and
it **names the specific journal entry** that was altered — not a general warning
that something somewhere is wrong.

That specificity is the demonstration. Any system can claim its records are
immutable. This one lets an outsider break a record on camera and then locates the
break by entry number, because each entry's hash covers the entry before it, so a
change to any single row can only be consistent with itself and not with its
successor.

**Reset** repairs it. The chain is verifiable again immediately afterwards.

---

## What this means for the recording

The harness makes the recorded demonstration reproducible in a way a live system
could not be: same clock, same data, same starting point, every take. The four
controls map onto four things a viewer is entitled to be sceptical about:

| Control | The scepticism it answers |
|---|---|
| Persona switcher | "Are those role restrictions real, or just hidden buttons?" |
| Portal switcher | "Is this one application pretending to be four?" |
| Demo clock | "Are those overdue statuses and discounts hardcoded?" |
| Break the chain | "Would you actually detect tampering, or just claim you would?" |

---

*Next: [The citizen portal](02-citizen-portal.md). Or return to the
[manual index](README.md).*
