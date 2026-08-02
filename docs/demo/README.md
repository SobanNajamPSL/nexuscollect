# The recorded demonstration

Everything needed to reproduce, re-record, or re-cut the film that shows what this
platform does.

| | |
|---|---|
| [`SHOT-LIST.md`](SHOT-LIST.md) | Every beat, in order, with what is on screen and the caption text |
| [`recordings/`](recordings/) | The film and the standalone beat clips |
| `../../scripts/record-demo.ts` | The script that produces them. **This is the authoritative version of the demonstration** — the narration lives in the code, so the film can always be regenerated from it |
| [`KNOWN-GAPS.md`](KNOWN-GAPS.md) | What the demonstration does not show, and why |

## What is delivered

**One continuous film** (`nexuscollect-full-demonstration`) following the whole arc,
and **seven standalone clips** (`beat-00-…` to `beat-06-…`) covering the same
material one beat at a time — so any single moment can be dropped into a deck, or
re-recorded, without redoing the rest.

Each clip is self-contained. A beat that needs state an earlier beat produced sets
that state up for itself, so `beat-05-cheque-bounces` makes sense to somebody who
has not watched `beat-02-counter`.

## The arc

Problem-first, then chronological. The audience is a ministry or a collecting
agency, so it opens on the thing they actually care about — what an agency can say
about its own money — and only then rewinds to show how that figure came to exist.

| Beat | What it shows |
|---|---|
| 0 | **Cold open.** An agency's collection position: confirmed, settled and swept as three separate numbers, broken down by revenue head. |
| 1 | **A citizen pays.** One vehicle registration returns three bills across two agencies. A live discount. An already-paid bill returned with its receipt. One tap produces two payments and two receipts. The receipt in English and Urdu, verified offline in the browser, then failing when a digit is altered. |
| 2 | **The counter.** A teller takes cash — capturing the amount owed and returning the change — then lodges a cheque whose credit is provisional and stays that way. |
| 3 | **The agency again.** The position has moved by exactly what happened. Swept is still zero, and that is correct. |
| 4 | **Reconciliation.** Eleven breaks, three of which resolve themselves. An analyst proposes a resolution and cannot approve it; an approver in a different role does. |
| 5 | **The cheque bounces.** One action unwinds every allocation, un-settles every bill, voids every receipt, resumes surcharge from the original due date, re-closes the service gate, and raises a dishonour charge. The payer's receipt now verifies as voided. |
| 6 | **Prove it.** Five control assertions re-performed against the live ledger. Then the ledger is deliberately corrupted from outside the product, and the platform names the specific journal entry that was altered. Reset, verify again, and sweep to treasury with a scroll whose control total ties. |

## Recording it again

The four portals and the API must be running (see the root `README.md`). Then:

```bash
npx tsx scripts/record-demo.ts --dry     # rehearse headlessly, no video written
npx tsx scripts/record-demo.ts           # the film and every beat
npx tsx scripts/record-demo.ts --film    # just the continuous film
npx tsx scripts/record-demo.ts --beats   # just the standalone clips
```

Two flags are for working on a take rather than producing one:

```bash
npx tsx scripts/record-demo.ts --beats --only=04-reconcile   # re-record one beat
npx tsx scripts/record-demo.ts --dry --keep --only=02-counter  # leave the data to inspect
```

**Always rehearse with `--dry` first.** It runs every interaction and every
assertion at full strength — only the reading pauses are shortened — so a selector
that has moved or a button that has been renamed fails in seconds rather than
halfway through a twelve-minute take.

## Why it looks the way it does

**It is a silent film with captions burned in.** The captions are injected into the
page by the script rather than added in an editor, because the film has to be
watchable as-is by somebody who was not in the room. They sit at the bottom over a
gradient, in a typeface none of the portals use, so they are unmistakably narration
rather than part of the product.

**It is paced for a person, not for the software.** The commonest way a screen
recording becomes useless is being cut at the speed the machine responds. Captions
are held long enough to read.

**Every take is identical.** The database is reset before each one and the clock is
pinned to 30 July 2026, 12:00 Asia/Karachi, so the same actions produce the same
numbers on the same screens — today, next week, or in a year. There is no randomness
anywhere the camera can see.

**Nothing on screen is staged.** Every figure comes from the platform running
against its seeded data. The captions name real amounts, real PSIDs and real receipt
numbers, and where a caption names a specific cheque the script locates that cheque
by its number rather than clicking whatever happens to be first in the table — so
the narration cannot drift away from what is being shown.

## Format

Recorded at 1920×1080. Playwright writes `.webm`; `scripts/convert-recordings.sh`
produces H.264 `.mp4` alongside it for playback anywhere.

```bash
bash scripts/convert-recordings.sh
```
