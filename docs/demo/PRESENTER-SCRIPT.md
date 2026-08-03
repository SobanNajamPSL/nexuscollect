# Presenter script

For recording the demonstration yourself, live, talking over it.

This is not a voiceover script — do not read it aloud. Each step gives you **what to
do**, **what to make** (the points worth landing, in your own words), and **what you
should see** so a figure never surprises you on camera. Say it the way you would to
somebody sitting next to you.

Put this on a second screen. Every section is independently recordable, so a fumble
costs you one section, not the film.

---

## Before you record

**1. Everything running?**

```bash
curl -s localhost:3000/health          # {"status":"ok"}
```

All four portals should answer:

| Portal | URL | Persona to pick |
|---|---|---|
| Citizen | http://pay.localhost:5174 | none — it's public |
| Agency | http://agency.localhost:5175 | **Bilal Farooq** |
| Operator | http://ops.localhost:5176 | **Imran Qureshi** |
| Field | http://field.localhost:5177 | **Nadia Aslam** |

If a portal is down: `npm --prefix web run dev:agency` (or `:citizen`, `:ops`, `:field`).

**2. Reset to a clean start.** Press **Reset** in the dark harness bar, or:

```bash
curl -s -X POST localhost:3000/internal/demo/reset
```

Do this before **every** take. It takes under ten seconds and it is the only way two
takes produce the same numbers.

**3. Tidy the screen.** Hide the bookmarks bar, close other tabs, turn off
notifications (macOS: Do Not Disturb), and set the browser to 1920×1080 if you can.
Zoom at 100%.

**4. Have four tabs open in this order** — citizen, agency, operator, field. You will
move between them, and the harness bar has portal links if you'd rather click those on
camera.

**5. Know your two escape hatches.** If something goes wrong mid-take: **Reset**
returns everything to the start, and every section below can be re-recorded on its own.

---

## 0 · The two opening slides

**Open:** `docs/demo/slides/index.html` — double-click it, or drag it into Chrome.
Press **F** for full screen, arrow keys or a click to advance.

They are in the browser rather than in Keynote deliberately: the rest of the
demonstration is a screen recording of Chrome, so opening here means no app switch on
camera, no resolution change, and no chance of a presenter-view window appearing in the
capture.

**Slide 1 — what it is.** Let it sit for a moment before speaking.

- A single place to settle anything owed to government, and a way for each agency to
  prove what it collected and where the money went.
- Walk the three claims. They are the promises the rest of the recording has to keep,
  so say them as promises: *one reference finds every bill, any channel can pay it,
  every rupee is provably attributed.*
- Worth adding out loud: this is a demonstration build, and every figure they are about
  to see is real data from a fixed dataset — not mocked screens.

**Slide 2 — what they're about to watch.**

- Four portals, four different audiences. Emphasise that these are *separate*
  applications, not tabs in one window: a citizen's payment screen and a reconciliation
  console have nothing to do with each other.
- Run down the eight steps quickly. You are giving them a map, not explaining anything
  yet.
- Land the two things worth watching for. Setting these up in advance is what makes
  them land later — the audience is now waiting for the eleven, and for the tamper.

Then switch to the agency portal and begin.

> Keep it to about **90 seconds for both slides**. They are a frame, not a pitch, and
> the product is the argument.

---

## Run order

Two slides then nine sections, about 22 minutes at a comfortable pace. Sections marked **CORE** make
the argument on their own — that cut runs about 12 minutes. The rest are depth you can
include or drop depending on the room.

| | Section | Portal | CORE | ~Time |
|---|---|---|---|---|
| 0 | The two opening slides | Browser | ✓ | 1m 30s |
| 1 | Where the money ends up | Agency | ✓ | 1m 30s |
| 2 | The agency asks to be paid | Agency | | 1m 30s |
| 3 | The citizen pays | Citizen | ✓ | 4m |
| 4 | The receipt | Citizen | ✓ | 2m 30s |
| 5 | Across the counter | Field | | 3m |
| 6 | The position has moved | Agency | ✓ | 1m |
| 7 | Reconciling the day | Operator | ✓ | 3m 30s |
| 8 | The cheque bounces | Operator → Citizen | ✓ | 2m |
| 9 | Prove all of it | Operator | ✓ | 3m |

---

## 1 · Where the money ends up — **CORE**

**Portal:** agency, as Bilal Farooq · **Screen:** Position

**Do**
1. Open the agency portal. Pick **Bilal Farooq** from *Acting as*.
2. Land on **Position**. Pause a beat before speaking.
3. Scroll slowly to the head-wise table, then to bills issued.

**Make these points**
- Start here because it is what a finance officer actually asks: *what can I say about my own money today?*
- This is one agency — Excise and Taxation, Punjab — on one day.
- **There is no number called "collected".** That is the single most important decision in the product.
- Three figures, three different truths: **confirmed** is money applied to their bills; **settled** is the bills it fully paid off; **swept** is cash that has physically reached treasury.
- Blur those together and an agency reports money as received before it has arrived. That is how a collection system misstates its own position without anyone lying.
- Swept is zero here because the sweep has not run. It is meant to lag — that is why it can be trusted.
- The table below is by **revenue head** — the budget line each rupee is credited to. Government accounts work this way, so this is the view their people actually use.
- Surcharge has its own line. It is never folded into the tax it accrued on, so you can always see how much of a day's take is penalty rather than principal.

**You should see**

| | |
|---|---|
| Confirmed · Settled · Swept | **723,350.00** · **723,350.00** · **0.00** |
| Revenue heads | E04210, E04215, E04220, E04288 (surcharge), E04291 — total 723,350.00 |
| Bills | 1 issued, 9 overdue, 21 settled — **220,900.00** outstanding |

> **Do not skip the footer.** *"All figures are computed from the platform ledger"* — worth saying out loud that nothing on this screen is typed in.

---

## 2 · The agency asks to be paid

**Portal:** agency · **Screen:** Request to pay

**Do**
1. Click **Request to pay**.
2. Find **R260005** (Ali Hassan Raza, PKR 16,500.00, status DELIVERED).
3. Click **Mark presented**, then **Payer accepts**.

**Make these points**
- Everything so far assumes the payer comes looking. This is the platform asking instead.
- Fourteen requests, eight different states — a request is a conversation that can end several ways, and the agency needs to see which ended how.
- Walk it: delivered to their phone → they open it → they accept.
- **Accepting is not paying.** No money has moved. The bill is still outstanding. Hold on this — it is the distinction most systems get wrong.
- Say you'll come back to this request once the money actually arrives.

**You should see** R260005 move `DELIVERED → PRESENTED → ACCEPTED`, and the status
chips at the top re-count.

> ⚠️ **Be straight about this:** there is no citizen inbox in this build and no notification is actually sent, so you are driving the payer's side from the agency screen. Say so. The lifecycle and the audit trail are real; the delivery channel is not.

---

## 3 · The citizen pays — **CORE**

**Portal:** citizen · **Screen:** Pay a bill

**Do**
1. Switch to the citizen portal. Point out there is no sign-in.
2. Leave the reference as **LEA-17-1000** (a vehicle registration). Click **Find my bills**.
3. Let the results sit. Scroll through them slowly.
4. Point at the discount line, then the *Already paid* row.
5. Click **Pay all 3 bills — PKR 16,750.00**.

**Make these points**
- No account, no password. A bill is found with a reference the payer already has — printed on a notice, on their windscreen, on a challan.
- One vehicle registration, **three bills, two different agencies**, one list. Without a shared platform this person visits two organisations.
- The e-challan has a **live early-payment discount** — PKR 1,250 off while it lasts, and the figure shown already has it applied. They are quoted what they will be charged.
- The fourth bill is already paid, and it comes back **with its receipt attached** rather than as an error. That one behaviour prevents most duplicate payments.
- Before you tap: one action, but the platform will make **two payments** — because a payment belongs to exactly one agency and is swept into exactly one treasury account. A single payment across two agencies could never be settled correctly.
- That is also the answer to the question every agency asks about a shared platform: *how do I know my money is mine?* It was never mixed.

**You should see**

| | |
|---|---|
| Result | 3 bills across 2 agencies, **PKR 16,750.00** |
| ETPB | 31010900000181526 — Motor Vehicle Token Tax — 10,000.00, overdue |
| PSCA | 41011300000190123 — moving violation — 3,750.00, **1,250.00 discount live** |
| PSCA | 41011400000286611 — parking — 3,000.00, overdue |
| Already paid | 41011400001606295, receipt **PSCA20260727000000004** |
| After paying | Two receipts: **ETPB20260730000000005** (10,000.00) and **PSCA20260730000000007** (6,750.00) |

**Optional, ~30s:** switch the lookup to **Bill number (PSID)**, type
`31010900000181527` (a real PSID with the last digit changed) and submit. It is rejected
instantly — the check digit fails arithmetically before any database is touched, so a
typo can never be confused with "no such bill", and it can't be used to probe for real
ones.

---

## 4 · The receipt — **CORE**

**Portal:** citizen · **Screen:** the PSCA receipt

**Do**
1. Open the **Punjab Safe Cities Authority** receipt.
2. Scroll through it. Stop on the head-wise breakdown, then the amount in words.
3. Click **اردو**. Let it sit for a few seconds.
4. Click **English**, then **Verify as issued**.
5. Click **Alter one digit**.

**Make these points**
- This is the artefact that outlives the transaction — printed, filed, and audited years later. It is held to that standard.
- It is rendered **from the signed payload**, not from a convenient query. What the payer reads is what was cryptographically signed, so a receipt that displays cannot disagree with a receipt that verifies.
- The breakdown shows three revenue heads across two bills, and **it sums to the total**. A receipt whose parts don't add up to its own total is the first thing an auditor rejects.
- The discounted challan contributes 3,750, not its 5,000 principal. What was quoted is what the ledger recognises.
- Amount in figures **and words** — the words are what make a printed receipt hard to alter.
- Urdu: right-to-left, in proper Nastaliq, amount spelled out. Note the revenue head names stay in English deliberately — those are the agency's own published chart-of-accounts descriptions and inventing translations would be fabricating reference data.
- **Verify as issued:** this check runs in the browser, against the public key on the receipt. No network, no database. That is what makes a receipt verifiable by somebody with no access to the platform at all.
- **Alter one digit:** it fails. Somebody holding the receipt and the key can tell genuine from altered.

**You should see**

| | |
|---|---|
| Heads | C05110 3,750.00 · C05115 2,000.00 · C05191 1,000.00 |
| Total | **PKR 6,750.00** — "Rupees Six Thousand Seven Hundred Fifty Only" |
| Verify | ✓ *Signature valid* → ✗ *Signature invalid* |
| Both say | *"Checked in this browser, with no network or database access"* |

---

## 5 · Across the counter

**Portal:** field, as Nadia Aslam

**Do**
1. Switch to the field portal. Note the design before doing anything.
2. **Take a payment:** enter `5101150000142`, click **Look up**. Enter `3000` tendered. Click **Accept**.
3. **Lodge a cheque:** PSID `12010400001899869`, number `004901`, amount `247968.00`, drawer *Zenith Clearing Agents (Pvt) Ltd*, bank *Habib Bank Limited*. Lodge it.
4. **Close the till:** enter a counted amount a few hundred off what it expects.

**Make these points**
- Oversized targets, high contrast, one task per screen — because this is used standing up, in poor light, with somebody waiting.
- **Cash:** the amount due is computed live, so a surcharge accrued since the bill was printed is already in it.
- The payer hands over 3,000 for a 2,480 bill. The platform captures **2,480** and tells the teller to return 520 — because the drawer only keeps what it keeps. Capturing the tender would overstate collections and guarantee the till came up short at close.
- Nothing about cash is special-cased. Same pipeline as a bank app, same waterfall, same ledger, same gapless receipt number. Channel is CASH, rail is CASH, and that is the only difference.
- **The cheque is provisional and stays provisional.** The bank can still take this money back, so it can never be swept to treasury, and the receipt says so on its face. Remember this cheque.
- **Till close:** the difference is posted to the ledger as a real over/short entry, not absorbed into a rounding line. A drawer that is over by a few hundred is a fact about the day, and the trial balance still ties afterwards.
- Worth mentioning: only a **teller** can accept money. A branch supervisor cannot — a supervisor reverses a teller's mistakes, and somebody who can both take money and reverse it is not a control. Switch to **Kamran Butt** and try if you want to show it being refused by the server.

**You should see** the cash bill due **2,480.00**, change **520.00**; the cheque lodged
with a provisional warning; the till showing a real over/short.

---

## 6 · The position has moved — **CORE**

**Portal:** agency · **Screen:** Position

**Do** Go back to the agency portal and Position. Also open **Request to pay** again.

**Make these points**
- Confirmed has risen by exactly what happened — nothing was entered by hand.
- **Swept is still zero**, and that is correct: the money is against the bills but has not left the collection account.
- On Request to pay: **R260005 now reads FULFILLED**, and nobody pressed anything. The platform recognised its own money and closed the request. That is the whole reason fulfilment is a separate step from acceptance — an agency needs to know which requests were *paid*, not merely which were agreed to.

> ⚠️ Only true if you did section 2 **and** the payer paid that bill. If you skipped section 2, skip the Request-to-pay half of this.

---

## 7 · Reconciling the day — **CORE**

**Portal:** operator, as Imran Qureshi → Ayesha Riaz

**Do**
1. Operator portal, **Break register**. Note it is empty.
2. Click **Run reconciliation**.
3. Read the summary, then scroll the open breaks, then the resolved ones.
4. On the **B08** break click **Propose a resolution**, choose *Escalate to agency*, type a sentence of what you found, click **Propose**.
5. Switch *Acting as* to **Ayesha Riaz**. Click **Approve**.

**Make these points**
- Cross-agency, organised around queues rather than dashboards.
- Three-way reconciliation: the bank's statement, the switch's settlement file, the rail's settlement file.
- **Eleven breaks. Not ten, not twelve.** The dataset has exactly eleven planted discrepancies and the engine finds exactly those. That is very hard to fake, and it is the check worth pointing at.
- **A break is a disagreement, not missing money.** PKR 764,109.50 unexplained does not mean money is gone. Most of these are filing problems — a treasury line posted to a head not valid for the period, a switch fee 7.50 above contract, a bank booking a day later than the platform.
- Three resolved themselves: two timing differences across a date boundary and one settlement row the switch sent twice. Mechanically identifiable, so no human is asked.
- The bank narrative is quoted **verbatim** — *"TOKEN TAX LEA 17 1000 PAYMENT AHMED"*. One of the two unmatched credits is resolvable from that text because it contains a vehicle registration. The other genuinely is not, and the platform doesn't pretend otherwise.
- **Maker-checker:** the analyst proposes and *cannot* approve. Show that there is no approve button for them.
- Then switch person. Enforced twice: same user id refused, **and** proposing and approving require different roles. Two accounts belonging to one person defeats an id check — it does not defeat this.
- Both names end up against the resolution, with what they said and when.

**You should see**

| | |
|---|---|
| After the run | **11 breaks found**, **3 auto-resolved**, **PKR 764,109.50** open and unexplained |
| Open | B08 critical · two B01 · B02 · B06 · B03 · B07 · B09 |
| Resolved | two B05 timing · one B04 duplicate — marked *auto-resolved by the run* |

> ⚠️ Break register and Today look **empty** until you run reconciliation. That is an unstarted day, not a fault — say so rather than clicking around.

---

## 8 · The cheque bounces — **CORE**

**Portal:** operator → citizen

**Do**
1. **Instrument clearing**. Find cheque **004901** (the one from section 5).
2. Click **Return (dishonour)**, reason *insufficient funds*.
3. Read out what the platform reports.
4. Switch to the citizen portal → **Check a receipt** and verify a receipt that cheque had produced.

**Make these points**
- Three days later the bank returns it. One action — and watch what it has to undo.
- Every allocation the cheque funded is reversed. Every bill it settled is un-settled. Every receipt it produced is **voided — never deleted**, and still linked to the original.
- Surcharge resumes from the **original** due date. The bill gets no holiday for the time it sat as provisionally paid. That detail is where most systems quietly lose money.
- The service gate closes again, and a dishonour charge is raised automatically.
- Then the part that lands hardest: **a receipt that verified as valid an hour ago now verifies as VOIDED**, with the reason. That is why status is the headline of the public verification screen and not a footnote.

> If you skipped section 5, use the seeded cheque **004822** (IN-0004, PKR 644,112.00) instead — but note it arrives already returned in the seed data, so its cascade has already run. Better to do section 5.

---

## 9 · Prove all of it — **CORE**

**Portal:** operator · **Screens:** Control assertions, then Sweep

**Do**
1. **Control assertions.** Click **Re-perform all five**.
2. Walk the five rows.
3. Click **Break the chain** in the dark harness bar.
4. Click **Re-perform all five** again. Read the failure out loud.
5. Click **Reset**, go back, re-perform. All five green.
6. **Sweep operations** → **Run sweep** for an agency.

**Make these points**
- These are not a status page. Every one is recomputed against the live ledger the moment you ask, because a stored "all green" proves nothing.
- Trial balance ties. Allocations reconcile. **Every cached balance rebuilds byte-identically** — throw the cached columns away, recompute from the allocations, get the same numbers to the paisa. That third one is the quiet proof that cached figures are only ever a cache.
- Ledger agrees with sub-ledger. Hash chain intact.
- Now break it deliberately. Be explicit that this button is **not part of the product** — it lives in the demonstration harness, and nothing a real user can reach corrupts the ledger.
- Re-perform: **it names the specific journal entry**. Not "something is wrong" — `journal_entry#1`, by number, because each entry's hash covers the one before it, so an altered row can only be consistent with itself.
- Any system can claim its records are immutable. This one invites you to break one and then tells you which one you broke.
- Reset repairs it. Same actions, same numbers, every time.
- **The sweep** moves confirmed, final money to treasury and refuses anything provisional. The scroll is the hand-off: one line per allocation, with a control total, and it is never emitted unless that total ties exactly to the ledger — because treasury is being asked to acknowledge receipt of exactly what the platform says it sent.

**Close on this:** one reference finds every bill. One payment is provably split across
heads and agencies. Every discrepancy is found, and resolved by two people. Nothing
reaches treasury unless it ties. And if anybody alters the record, the platform names
what they touched.

**You should see** five PASS → after the tamper, four PASS and the hash-chain row
**FAIL** reading `tampering detected: {"label":"journal_entry#1","reason":"hash_self_mismatch"}`,
with a banner saying the failure is locatable rather than merely alarming.

---

## Things that will trip you up

| | |
|---|---|
| Recon screens look empty | Correct until you press **Run reconciliation**. Not a fault. |
| The analyst can't approve a break | That is the control working. Switch to **Ayesha Riaz**. |
| A supervisor can't take a payment | Also deliberate (§3.2). Switch to **Nadia Aslam**. |
| Sweep says nothing to sweep | Provisional money is refused by design. Confirm a payment first. |
| Figures don't match this script | Press **Reset**. Something from an earlier take is still in the data. |
| A number looks wrong on camera | Say so and move on. Every figure here is checked against the fixture — if it differs, the data isn't clean. |

## If you want a shorter cut

**~13 minutes:** slides, then sections 1, 3, 4, 6, 7, 8, 9. Skip the Request to Pay and the counter.
You lose the platform-initiated journey and the cash channel, and you keep the whole
argument: cross-agency lookup, a real receipt, reconciliation under maker-checker, the
dishonour cascade, and the tamper being caught by name.

**~7 minutes, if you only get one shot:** slide 1, section 1 (the three numbers),
section 3 (one reference, two agencies), and section 9 (break the chain). That is the product's claim,
its proof, and the reason to believe it.
