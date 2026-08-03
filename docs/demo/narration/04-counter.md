# 04-counter — A teller takes cash and lodges a cheque

9 lines, 300 words, roughly 1m 49s at a measured pace.

Read the passages in order. **Pause for one to two seconds between them** — that is
how the split finds the boundaries. Nothing appears on screen, so the narration
carries the whole explanation; say it as you would to somebody sitting beside you.

---

### 01

The same day, at a counter. Oversized targets, high contrast, one task per screen — because this is used standing up, in poor light, with somebody waiting.

### 02

Cash across the counter. The amount due is computed live, so a surcharge that has accrued since the bill was printed is already in it. The teller reads it back before accepting the money.

### 03

Tendered, and the change to return. The platform works out the change so the teller does not have to.

### 04

Nothing about cash is special-cased. Same apply pipeline as a bank app: allocated across the bill's line items by the product's waterfall, posted to the ledger, receipted with a gapless per-agency number. The channel is CASH and the rail is CASH — and that is the only difference.

### 05

Lodging a cheque. A physical instrument accepted across the counter. This did not exist until the field portal was built: the platform could unwind a bounced cheque but had no way to accept one, because every seeded cheque came from the data loader.

### 06

Cheque 004901, for PKR 247,968.00. Tendered against one overdue sales-tax bill. Remember this cheque — the bank has not paid it yet.

### 07

The credit is provisional, and stays provisional. The bank can still take this money back, so it can never be swept to treasury, and the receipt says so on its face rather than implying the obligation is discharged.

### 08

Closing the till. The teller counts the drawer. Any difference from what the platform expected is posted to the ledger as a real over/short entry, not absorbed into a rounding line — and the trial balance still ties afterwards.

### 09

Only a teller can accept money. A branch supervisor cannot. A supervisor reverses a teller's mistakes, and somebody who can both take money and reverse it is not a control.

