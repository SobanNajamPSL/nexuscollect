# Shot list

Every beat, in order, with what is on screen and the caption that appears over it.
The authoritative version is `scripts/record-demo.ts` — this document exists so the
film can be reviewed, re-cut or re-narrated without reading code.

Recorded at 1920×1080, on the pinned demonstration clock of **2026-07-30 12:00
Asia/Karachi**. Every amount, PSID and receipt number below is real data from the
seeded dataset.

---

## Beat 0 — Cold open: an agency's own position

**Portal:** agency, as Bilal Farooq (agency administrator, ETPB)
**Screen:** Collection position

| Caption | |
|---|---|
| *NexusCollect — collecting money owed to government* | Start where the audience cares: what one agency can say about its own money, on one business date. |
| *Three numbers, never one* | Confirmed is what has been applied to this agency's bills. Settled is which bills that discharged. Swept is cash that has actually reached the treasury account. A collection system that reports one figure called 'collected' is misstating its own position. |
| *Broken down by revenue head* | Government reporting is organised by head, not by transaction. Surcharge is collected against its own head rather than folded into the tax it accrued on, which is what makes it separately auditable. |
| *And what is still owed* | Thirty-one bills raised, PKR 220,900.00 outstanding. Now rewind and watch one day's money produce those numbers. |

**On screen:** Confirmed PKR 723,350.00 · Settled PKR 723,350.00 · Swept PKR 0.00.
Five revenue heads (E04210, E04215, E04220, E04288, E04291) totalling 723,350.00.
Bills issued: 1 issued, 9 overdue, 21 settled.

---

## Beat 1 — The agency asks to be paid

**Portal:** agency, as Bilal Farooq (agency administrator, ETPB)
**Screen:** Request to pay

| Caption | |
|---|---|
| *Before waiting, ask* | Everything so far assumes the payer goes looking for their bill. A Request to Pay is the platform asking instead — addressed to a phone number, carrying its own lifecycle, with every step recorded. |
| *Fourteen requests, in eight different states* | Sent, delivered, presented, accepted, declined, expired, cancelled, undeliverable. A request is a conversation that can end several ways, and an agency needs to see which ended how. |
| *Request R260005, for PKR 16,500.00* | Delivered to the payer's phone, not yet opened. |
| *The payer opens it* | Presented — it is now in front of them. |
| *And accepts — which is not the same as paying* | Accepting is the payer agreeing. No money has moved. The bill is still outstanding, and the request will sit here until it is actually settled. |

**On screen:** the seeded request `R260005` against PSID `31010900000396648`, walked
`DELIVERED → PRESENTED → ACCEPTED` using the screen's own buttons.

**Note on what this build does and does not do:** the payer's side of a Request to
Pay is driven from the agency screen here, because there is no citizen inbox and the
platform sends no real notification — see `KNOWN-GAPS.md`. The lifecycle, the state
machine and the audit trail are real; the delivery channel is not.

---

## Beat 2 — The request closes itself

**Portal:** citizen, then agency
**Screens:** Find a bill → receipt → Request to pay

| Caption | |
|---|---|
| *The payer pays it — through their own bank* | Nothing special. The same lookup, the same pipeline, the same rail as any other payment. A Request to Pay changes who starts the conversation, not how the collection works. |
| *Paid, and receipted* | PKR 16,500.00, against the bill the request named. |
| *FULFILLED — and nobody pressed anything* | The platform recognised its own money and closed the request. That distinction is the whole reason fulfilment is a separate step from acceptance: an agency needs to know which of its requests were *paid*, not merely which were agreed to. |

**On screen:** the request's status moving to `FULFILLED` with no operator action, and
its `fulfilling_payment_id` pointing at the payment that settled it.

---

## Beat 3 — A citizen pays bills across two agencies, cold

**Portal:** citizen (public, no persona)
**Screens:** Find a bill → receipts → one receipt

No request this time — the payer arrives with a reference and nothing else, which is
the other half of the story.

| Caption | |
|---|---|
| *The citizen portal* | Public. No account, no password, no sign-in. A bill is found with a reference the payer already has in their hand. |
| *One vehicle registration, two agencies, three bills* | LEA-17-1000 returns bills from the Excise department and from the Safe Cities Authority, in one list, for PKR 16,750.00. Without a shared platform this payer visits two organisations. |
| *The discount is live, and already applied* | PKR 1,250.00 off the moving-violation challan while it lasts. The PKR 3,750.00 shown is what will be charged — and what the ledger will record. |
| *A bill already paid comes back with its receipt* | Not an error, and not an empty result. Showing the payer proof they already paid is what prevents the commonest duplicate payment there is. |
| *One tap — but two payments, and two receipts* | A payment belongs to exactly one agency, because the sweep moves it into one treasury account and the scroll is emitted per agency. So the split is real. That is also the answer to 'how do I know my money is mine': it was never mixed. |
| *The receipt is rendered from the signed payload* | Not from a convenient query — from the bytes that were cryptographically signed. A receipt that displays cannot disagree with a receipt that verifies. |
| *Head-wise, and it adds up* | PKR 6,750.00 across three revenue heads and two bills. The discounted challan contributes 3,750.00, not its 5,000.00 principal. A receipt whose parts do not sum to its total is the first thing an auditor rejects. |
| *In Urdu, right-to-left, with the amount in words* | The words are what make a printed receipt hard to alter. Revenue head names stay in English deliberately — they are the agency's own published descriptions, and inventing translations would be fabricating reference data. |
| *Verified in the browser, with nothing sent anywhere* | An Ed25519 check run locally against the public key on the receipt. No network, no database — which is what offline verification has to mean to be worth claiming. |
| *Change one digit and it fails* | Somebody holding the receipt and the public key, with no access to the platform at all, can tell a genuine receipt from an altered one. |

**On screen:** ETPB20260730000000005 (PKR 10,000.00) and PSCA20260730000000007
(PKR 6,750.00). Heads C05110 / C05115 / C05191. Urdu total in words:
چھ ہزار سات سو پچاس روپے صرف.

---

## Beat 4 — The counter

**Portal:** field, as Nadia Aslam (teller)
**Screens:** Take a payment → Lodge a cheque → Close the till

| Caption | |
|---|---|
| *The same day, at a counter* | Oversized targets, high contrast, one task per screen — because this is used standing up, in poor light, with somebody waiting. |
| *Cash across the counter* | The amount due is computed live, so a surcharge that has accrued since the bill was printed is already in it. The teller reads it back before accepting the money. |
| *Tendered, and the change to return* | The platform works out the change so the teller does not have to. |
| *Nothing about cash is special-cased* | Same apply pipeline as a bank app: allocated across the bill's line items by the product's waterfall, posted to the ledger, receipted with a gapless per-agency number. The channel is CASH and the rail is CASH — and that is the only difference. |
| *Lodging a cheque* | A physical instrument accepted across the counter. This did not exist until the field portal was built: the platform could unwind a bounced cheque but had no way to accept one, because every seeded cheque came from the data loader. |
| *Cheque 004901, for PKR 247,968.00* | Tendered against one overdue sales-tax bill. Remember this cheque — the bank has not paid it yet. |
| *The credit is provisional, and stays provisional* | The bank can still take this money back, so it can never be swept to treasury, and the receipt says so on its face rather than implying the obligation is discharged. |
| *Closing the till* | The teller counts the drawer. Any difference from what the platform expected is posted to the ledger as a real over/short entry, not absorbed into a rounding line — and the trial balance still ties afterwards. |
| *Only a teller can accept money* | A branch supervisor cannot. A supervisor reverses a teller's mistakes, and somebody who can both take money and reverse it is not a control. |

**On screen:** a PKR 2,480.00 water bill paid with PKR 3,000.00 tendered — the
platform captures 2,480.00 and returns 520.00, because the drawer only keeps what it
keeps. Cheque 004901 for PKR 247,968.00 against PSID 12010400001899869.

---

## Beat 5 — The agency's position has moved

**Portal:** agency, as Bilal Farooq
**Screen:** Collection position

| Caption | |
|---|---|
| *Back to the agency, after the money moved* | Confirmed has risen by exactly the PKR 10,000.00 token tax that citizen paid. Nothing here is entered by hand — every figure is computed from the ledger at the demonstration business date. |
| *Swept is still zero, and that is correct* | The money is confirmed against the bills but has not left the collection account. Swept lags on purpose: it is the number a finance officer can trust precisely because it is the most conservative of the three. |

---

## Beat 6 — Reconciliation, under maker-checker

**Portal:** operator, as Imran Qureshi (reconciliation analyst), then Ayesha Riaz (approver)
**Screen:** Break register

| Caption | |
|---|---|
| *The operator's back office* | Cross-agency, and organised around queues rather than dashboards. Reconciliation is three-way: the bank's statement, the switch's settlement file, and the rail's settlement file. |
| *Eleven breaks — and eleven is the point* | Not ten, not twelve. The dataset has exactly eleven planted discrepancies and the engine finds exactly those, which is very hard to fake. Three of them resolve themselves. |
| *A break is a disagreement, not missing money* | PKR 764,109.50 unexplained does not mean three quarters of a million rupees has gone. Most of these are filing problems — a treasury line posted to a head that is not valid for the period, a fee 7.50 above contract, a bank booking a day later than the platform. |
| *The mechanical ones resolve themselves* | Two timing differences across a date boundary, and one settlement row the switch sent twice. Identifiable without a human, so no human is asked. |
| *An analyst proposes a resolution* | Five options: match it manually, accept it as timing, reclassify it, write it off, or escalate to the agency. The narrative is not optional — somebody has to say what they found. |
| *And cannot approve it* | It moves to awaiting approval. The analyst has no button to finish the job. |
| *A different person, in a different role* | Maker-checker here is enforced twice: the same user id is refused, and proposing and approving require different roles. Two accounts belonging to one person defeats an id check — it does not defeat this. |
| *Resolved, with both names against it* | Who proposed it, who approved it, what they said, and when. That record is the reason a resolution can be trusted at all. |

**On screen:** 11 breaks found, 3 auto-resolved, PKR 764,109.50 open and unexplained.
B08 critical, two B01 unmatched bank credits, B02, B06, B03, B07, B09; B04 and two
B05 in the resolved section.

---

## Beat 7 — The cheque bounces

**Portal:** operator → citizen
**Screens:** Instrument clearing → public verification

| Caption | |
|---|---|
| *Three days later, the bank returns it* | Cheque 004901, PKR 247,968.00, insufficient funds — the one the teller took across the counter. One action, and watch what it has to undo. |
| *Everything it funded, unwound at once* | Every allocation the cheque funded is reversed. Every bill it settled is un-settled. Every receipt it produced is VOIDED — never deleted, still linked to the original. Surcharge resumes from the ORIGINAL due date, so the bill gets no holiday for the time it sat as provisionally paid. The service gate closes again. And a dishonour charge is raised automatically. |
| *And the receipt the payer is holding* | A receipt that verified as valid an hour ago now verifies as VOIDED, with the reason. That is why status is the headline of the public verification screen and not a footnote. |

---

## Beat 8 — Prove it

**Portal:** operator, as Imran Qureshi
**Screens:** Control assertions → Sweep operations

| Caption | |
|---|---|
| *Five control assertions, re-performed on demand* | Not a status page. Every one of these is recomputed against the live ledger the moment you ask, because a stored 'all green' proves nothing. |
| *Every entry balances, every cached balance rebuilds identically* | The third check is the quiet one: throw away every cached balance column, recompute from the allocations, and get the same numbers to the paisa. Cached figures are only ever a cache. |
| *Now break it, on camera* | The harness bar has a button whose only purpose is to corrupt a row in the financial ledger. Nothing in the product can do this. |
| *Caught, and named* | Not a general warning that something somewhere is wrong. The specific journal entry that was altered, by number — because each entry's hash covers the one before it, so a changed row can only be consistent with itself. |
| *Reset, and verifiable again* | Same actions, same numbers, every take. |
| *Finally, the money leaves* | The sweep moves confirmed, final money to treasury and refuses anything provisional. Run it for one agency and watch what it produces. |
| *And the scroll goes with it* | One line per allocation, with a control total. It is never emitted unless that total ties exactly to the ledger — because treasury is being asked to acknowledge receipt of exactly what the platform says it sent. |
| *That is the whole argument* | One reference finds every bill. One payment is provably split across heads and agencies. Every discrepancy is found, and resolved by two people. Nothing reaches treasury unless it ties. And if anybody alters the record, the platform names what they touched. |

**On screen:** five assertions passing; after the tamper, the hash-chain assertion
fails naming `journal_entry#1`; after reset, five passing again.
