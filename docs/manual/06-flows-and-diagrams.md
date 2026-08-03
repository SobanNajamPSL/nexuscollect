# 6. Flows & diagrams

This document collects the major end-to-end processes described throughout this manual into single visual diagrams, so you can see how the screens connect during a real, complete workflow — not just in isolation.

---

## How a citizen bill lookup actually resolves

This is what happens, in order, every time a reference is entered on [the citizen portal](02-citizen-portal.md). It happens in well under a second, but it is not a single step — several checks and lookups happen in a fixed sequence:

```mermaid
flowchart TD
    A[Citizen enters a reference<br/>e.g. VEHICLE_REG: LEA-17-1000] --> B{Does the reference<br/>pass its own check digit?}
    B -- No --> B1[Rejected instantly —<br/>INVALID_REFERENCE_CHECKSUM<br/>no database lookup even attempted]
    B -- Yes --> C[Look up every bill<br/>linked to this reference]
    C --> D[Recompute every amount live —<br/>surcharge, early-payment discount,<br/>using today's date]
    D --> E{Is this bill still eligible<br/>to be paid through this channel?}
    E -- No --> E1[Shown as not currently payable,<br/>with the specific reason]
    E -- Yes --> F[Mask sensitive payer detail<br/>appropriately for this lookup]
    F --> G[Return the full list:<br/>open payables + already-settled bills]
```

**Why the check-digit step happens first, before any database lookup:** a mistyped reference is extremely common, and catching it instantly — with zero database work — means a typo is never confused with "this bill doesn't exist," and it keeps the whole lookup fast even under heavy load.

---

## Assessment, Payment, and Allocation — how they connect

This expands on [the core concept](00-concepts.md#2-assessment-payment-and-allocation-are-three-separate-things) with a concrete, real example: the multi-head payment `P260000E` shown on the [agency portal](03-agency-portal.md) and [Payment 360°](04-operator-portal.md).

```mermaid
flowchart LR
    P["Payment P260000E<br/>PKR 943,880.00<br/>(one bank transfer)"]

    P -->|allocates PKR 920,000| A1["Assessment: Income Tax<br/>Revenue head B01101"]
    P -->|allocates PKR 12,880| A2["Assessment: Default Surcharge<br/>Revenue head B02388"]
    P -->|allocates PKR 11,000| A3["Assessment: Penalty<br/>Revenue head B02391"]
```

One single payment, from the payer's point of view, correctly funds three completely separate obligations — potentially spanning different bills and even different agencies — with the platform handling the split automatically according to each agency's configured allocation rules.

---

## The life of a payment

Every payment moves through a defined set of states. This diagram shows the possible paths — most payments take the simple, direct route down the left; the right-hand branches exist specifically for the harder real-world cases this manual covers.

```mermaid
stateDiagram-v2
    [*] --> CONFIRMED: Rail/channel confirms\ninstantly (the common case)
    [*] --> UNCERTAIN: Confirmation is\ngenuinely ambiguous

    UNCERTAIN --> CONFIRMED: Evidence shows\nit went through
    UNCERTAIN --> FAILED: Evidence shows\nit did not

    CONFIRMED --> REVERSED: Instrument dishonoured\n(e.g. cheque bounces)
    CONFIRMED --> PARTIALLY_REVERSED: Only part of the\npayment is reversed

    FAILED --> [*]
    REVERSED --> [*]
    PARTIALLY_REVERSED --> [*]
    CONFIRMED --> [*]
```

- **`CONFIRMED`** is where the large majority of payments land, and stay, permanently.
- **`UNCERTAIN`** (see [the UNCERTAIN Queue](04-operator-portal.md)) is a temporary holding state — every uncertain payment eventually resolves to either `CONFIRMED` or `FAILED`, based on real evidence, never a guess.
- **`REVERSED`** / **`PARTIALLY_REVERSED`** happen after a `CONFIRMED` payment turns out to be based on money that was never actually good — the [cheque dishonour cascade](04-operator-portal.md) is the clearest example.

---

## The cheque dishonour cascade, step by step

This is the full sequence behind [returning an instrument](04-operator-portal.md) on Screen 4 — six distinct effects, triggered by one action, always in this order:

```mermaid
flowchart TD
    Start["Bank reports a cheque\nhas bounced"] --> Action["Ops user clicks\n'Return (dishonour)'"]
    Action --> E1["1. The payment behind\nthe cheque is reversed"]
    E1 --> E2["2. Every bill it had settled\ngoes back to un-settled"]
    E2 --> E3["3. Surcharge resumes accruing\nfrom the ORIGINAL due date —\nno grace period"]
    E3 --> E4["4. The receipt that was issued\nis marked VOIDED\n(never deleted)"]
    E4 --> E5["5. Any service unlocked by\nthe payment is re-locked"]
    E5 --> E6["6. A new dishonour-charge bill\nis raised against the drawer"]
    E6 --> Done["Instrument now shows\nRETURNED"]
```

Every one of these six effects is visible and traceable — nothing about a dishonour happens silently. See [Instrument Register](04-operator-portal.md) for what each effect looks like on screen.

---

## Reconciliation: from source files to a resolved break

This shows the full path a mismatch takes, from the moment the day's source files arrive to the moment it's resolved — spanning [the Break Register](04-operator-portal.md) and [Recon Console](04-operator-portal.md).

```mermaid
flowchart TD
    S1["Bank statement file"] --> R["Three-way reconciliation\nengine runs"]
    S2["Switch settlement file"] --> R
    S3["Rail settlement file"] --> R
    L["Platform's own ledger"] --> R

    R --> Match{Do all sides\nagree?}
    Match -- Yes --> OK["No break —\nsettled cleanly"]
    Match -- No --> Classify{What kind of\nmismatch is this?}

    Classify -- "Duplicate file row\nor timing difference" --> Auto["Auto-resolved —\nshown as settled,\nnot an open alarm"]
    Classify -- "Everything else\n(unmatched credit, amount\nmismatch, aged unapplied\nmoney, etc.)" --> Open["Open break —\nneeds a human"]

    Open --> Investigate["Analyst investigates\nand proposes a resolution"]
    Investigate --> Approve{"A DIFFERENT person\nreviews the proposal"}
    Approve -- Approved --> Resolved["Break resolved"]
    Approve -- Rejected --> Investigate
```

The maker-checker step (a different person must approve) is not optional or bypassable — it is the same rule described in [the introduction](00-concepts.md#6-maker-checker-separation-of-duties), enforced here specifically for reconciliation breaks.

---

## The settlement and sweep cycle

This shows how money moves from being confirmed against a bill to actually reaching government treasury — the mechanics behind the three [agency portal](03-agency-portal.md) headline figures.

```mermaid
flowchart LR
    subgraph Day["During the business day"]
        Pay["Citizen pays a bill"] --> Alloc["Payment allocated\nto the bill"]
        Alloc --> Confirmed["CONFIRMED\n(agency's own\nbookkeeping updated)"]
        Confirmed --> Settled["Bill reaches\nSETTLED"]
    end

    subgraph Cycle["On the next sweep cycle"]
        Settled --> Check{"Is this money\nfinal (not a\nprovisional/uncleared\ninstrument)?"}
        Check -- No --> Wait["Excluded from this\nsweep — waits for\nthe instrument to clear"]
        Check -- Yes --> Sweep["Swept to treasury"]
        Sweep --> Scroll["A scroll is generated —\none line per allocation"]
        Scroll --> Tie{"Does the scroll's\ntotal tie exactly\nto the ledger?"}
        Tie -- No --> Refuse["Scroll is NOT emitted —\nthe mismatch must be\nfixed first"]
        Tie -- Yes --> Ack["Treasury acknowledges\nreceipt"]
    end
```

The **"tie exactly or refuse to emit"** rule is deliberate: the platform will never hand treasury a settlement document it cannot itself prove is correct to the paisa.

---

## Where each screen sits in the citizen's journey

A last, simpler diagram tying the six primary screens back to the actual sequence a citizen (and the staff supporting them) experience, end to end:

```mermaid
flowchart LR
    C1["1. Citizen Payment\nFind & pay a bill"] --> C2["2. Verify Receipt\nProve payment happened"]
    C1 -.->|"if a cheque was used\nand later bounces"| C4["4. Instrument Register\nDishonour cascade"]
    C1 -.->|"feeds the day's\nreconciliation"| C3["3. Break Register\nDaily reconciliation"]
    C1 -.->|"feeds agency's\nreported position"| C5["5. Agency Dashboard\nConfirmed / Settled / Swept"]
    C3 & C4 & C5 -.->|"all provably correct,\nverifiable anytime"| C6["6. Control Assertions\nLive proof of integrity"]
```

## What to do next

For quick definitions of any term used across these diagrams (waterfall, scroll, revenue head, and more), see the [Glossary](07-glossary.md).
