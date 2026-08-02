# 03-citizen-pays — A citizen pays bills across two agencies

10 lines, 361 words, roughly 2m 11s at a measured pace.

Read the lines in order. **Pause for one to two seconds between them** — that is how
the split finds the boundaries. The bold part is the on-screen heading; you can read
it as the opening phrase of the sentence or skip it, whichever sounds natural.

---

### 01

**The citizen portal.** Public. No account, no password, no sign-in. A bill is found with a reference the payer already has in their hand.

### 02

**One vehicle registration, two agencies, three bills.** LEA-17-1000 returns bills from the Excise department and from the Safe Cities Authority, in one list, for PKR 16,750.00. Without a shared platform this payer visits two organisations.

### 03

**The discount is live, and already applied.** PKR 1,250.00 off the moving-violation challan while it lasts. The PKR 3,750.00 shown is what will be charged — and what the ledger will record.

### 04

**A bill already paid comes back with its receipt.** Not an error, and not an empty result. Showing the payer proof they already paid is what prevents the commonest duplicate payment there is.

### 05

**One tap — but two payments, and two receipts.** A payment belongs to exactly one agency, because the sweep moves it into one treasury account and the scroll is emitted per agency. So the split is real. That is also the answer to 'how do I know my money is mine': it was never mixed.

### 06

**The receipt is rendered from the signed payload.** Not from a convenient query — from the bytes that were cryptographically signed. A receipt that displays cannot disagree with a receipt that verifies.

### 07

**Head-wise, and it adds up.** PKR 6,750.00 across three revenue heads and two bills. The discounted challan contributes 3,750.00, not its 5,000.00 principal. A receipt whose parts do not sum to its total is the first thing an auditor rejects.

### 08

**In Urdu, right-to-left, with the amount in words.** The words are what make a printed receipt hard to alter. Revenue head names stay in English deliberately — they are the agency's own published descriptions, and inventing translations would be fabricating reference data.

### 09

**Verified in the browser, with nothing sent anywhere.** An Ed25519 check run locally against the public key on the receipt. No network, no database — which is what offline verification has to mean to be worth claiming.

### 10

**Change one digit and it fails.** Somebody holding the receipt and the public key, with no access to the platform at all, can tell a genuine receipt from an altered one.

