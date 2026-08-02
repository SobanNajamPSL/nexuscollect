# 08-prove-it — Prove it: five assertions, a tamper, and the scroll

8 lines, 267 words, roughly 1m 37s at a measured pace.

Read the lines in order. **Pause for one to two seconds between them** — that is how
the split finds the boundaries. The bold part is the on-screen heading; you can read
it as the opening phrase of the sentence or skip it, whichever sounds natural.

---

### 01

**Five control assertions, re-performed on demand.** Not a status page. Every one of these is recomputed against the live ledger the moment you ask, because a stored 'all green' proves nothing.

### 02

**Every entry balances, every cached balance rebuilds identically.** The third check is the quiet one: throw away every cached balance column, recompute from the allocations, and get the same numbers to the paisa. Cached figures are only ever a cache.

### 03

**Now break it, on camera.** The harness bar has a button whose only purpose is to corrupt a row in the financial ledger. Nothing in the product can do this.

### 04

**Caught, and named.** Not a general warning that something somewhere is wrong. The specific journal entry that was altered, by number — because each entry's hash covers the one before it, so a changed row can only be consistent with itself.

### 05

**Reset, and verifiable again.** Same actions, same numbers, every take.

### 06

**Finally, the money leaves.** The sweep moves confirmed, final money to treasury and refuses anything provisional. Run it for one agency and watch what it produces.

### 07

**And the scroll goes with it.** One line per allocation, with a control total. It is never emitted unless that total ties exactly to the ledger — because treasury is being asked to acknowledge receipt of exactly what the platform says it sent.

### 08

**That is the whole argument.** One reference finds every bill. One payment is provably split across heads and agencies. Every discrepancy is found, and resolved by two people. Nothing reaches treasury unless it ties. And if anybody alters the record, the platform names what they touched.

