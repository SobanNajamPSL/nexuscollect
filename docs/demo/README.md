# The recorded demonstration

## ▶ The film

**https://youtu.be/QeXAlXBtSKE** — the delivered demonstration, presented and narrated
live, running 1 hour 12 minutes.

This is the reference cut: the full walkthrough, in depth, for an evaluation audience
with the time booked. It is a **human-presented recording**, not the automated capture
described further down — the script it follows is
[`PRESENTER-SCRIPT.md`](PRESENTER-SCRIPT.md), and the two opening slides are
[`slides/index.html`](slides/index.html).

Every figure in it is synthetic demonstration data on the fixed business date of
30 July 2026.

---

Everything else here is what produced that film, or what would produce another one.

| | |
|---|---|
| [`slides/index.html`](slides/index.html) | The two opening slides — what NexusCollect is, and a map of the walkthrough. Open in Chrome, **F** for full screen. |
| [`PRESENTER-SCRIPT.md`](PRESENTER-SCRIPT.md) | **For recording it yourself.** Nine independently-recordable sections: what to click, the points worth landing, and the figure you should see so nothing surprises you on camera. |
| [`SHOT-LIST.md`](SHOT-LIST.md) | The automated film's beats, in order, with the narration verbatim |
| [`recordings/`](recordings/) | The film and the standalone beat clips |
| `../../scripts/record-demo.ts` | Produces the automated film, and holds its narration beside the actions it describes. Also the determinism and route-sweep harness, which is why it stays useful regardless of how the demonstration is finally recorded |
| [`KNOWN-GAPS.md`](KNOWN-GAPS.md) | What the demonstration does not show, and why |

> **Recording it yourself is the primary route now.** See
> [`PRESENTER-SCRIPT.md`](PRESENTER-SCRIPT.md) and [`slides/`](slides/). Everything
> below describes the *automated* film — still useful as a determinism harness and as
> the raw material for a script, but not the deliverable it was built to be.

## What is delivered

**One continuous film** (`nexuscollect-full-demonstration`) following the whole arc,
and **nine standalone clips** (`beat-00-…` to `beat-08-…`) covering the same
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
| 1 | **The agency asks to be paid.** A Request to Pay through its lifecycle — fourteen requests across eight states, one taken from delivered to presented to accepted. Accepting is agreeing, not paying: no money has moved and the bill is still outstanding. |
| 2 | **The request closes itself.** The payer pays through their own bank, on the ordinary pipeline, and the request goes to FULFILLED with nobody pressing anything — because an agency needs to know which of its requests were *paid*, not merely which were agreed to. |
| 3 | **A citizen pays cold.** No request involved: one vehicle registration returns three bills across two agencies. A live discount. An already-paid bill returned with its receipt. One tap produces two payments and two receipts. The receipt in English and Urdu, verified offline in the browser, then failing when a digit is altered. |
| 4 | **The counter.** A teller takes cash — capturing the amount owed and returning the change — then lodges a cheque whose credit is provisional and stays that way. |
| 5 | **The agency again.** The position has moved by exactly what happened. Swept is still zero, and that is correct. |
| 6 | **Reconciliation.** Eleven breaks, three of which resolve themselves. An analyst proposes a resolution and cannot approve it; an approver in a different role does. |
| 7 | **The cheque bounces.** One action unwinds every allocation, un-settles every bill, voids every receipt, resumes surcharge from the original due date, re-closes the service gate, and raises a dishonour charge. The payer's receipt now verifies as voided. |
| 8 | **Prove it.** Five control assertions re-performed against the live ledger. Then the ledger is deliberately corrupted from outside the product, and the platform names the specific journal entry that was altered. Reset, verify again, and sweep to treasury with a scroll whose control total ties. |

Beats 1–3 are deliberately both ways round: the platform pulling (a request the payer
accepts) and the payer arriving cold with a reference. They are different journeys
and an agency will ask about both.

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
npx tsx scripts/record-demo.ts --beats --only=06-reconcile   # re-record one beat
npx tsx scripts/record-demo.ts --dry --keep --only=04-counter  # leave the data to inspect
```

**Always rehearse with `--dry` first.** It runs every interaction and every
assertion at full strength — only the reading pauses are shortened — so a selector
that has moved or a button that has been renamed fails in seconds rather than
halfway through a twelve-minute take.

## Why it looks the way it does

**There is no on-screen text.** An earlier cut burned the script into the frame as a
lower-third and it was removed for two reasons: text written to be read is not text
written to be spoken, and the gradient behind it covered the bottom of every frame —
including the last rows of the very tables the film argues about. The picture is now
only the product.

**It is paced for a person, not for the software.** The commonest way a screen
recording becomes useless is being cut at the speed the machine responds. Each beat is
held for as long as its narration takes to say — measured from the recorded audio where
that exists, and estimated from the word count where it does not yet.

**Every take is identical.** The database is reset before each one and the clock is
pinned to 30 July 2026, 12:00 Asia/Karachi, so the same actions produce the same
numbers on the same screens — today, next week, or in a year. There is no randomness
anywhere the camera can see.

**Nothing on screen is staged.** Every figure comes from the platform running against
its seeded data. The narration names real amounts, real PSIDs and real receipt numbers,
and where a passage names a specific cheque the script locates that cheque *by its
number* rather than clicking whatever happens to be first in the table — so the words
cannot drift away from what is being shown.

## Narration

The recorder produces silent video; the narration is added afterwards. The script is
already written — it lives beside the actions it describes in `scripts/record-demo.ts` —
and
[`narration/`](narration/) holds a recording sheet per beat, generated from the
same calls that put the text on screen, so the script and the picture cannot drift.

```bash
npx tsx scripts/record-demo.ts --dry --film --manifest   # regenerate the sheets
# record docs/demo/narration/audio/<beat>.wav, one take per beat
npx tsx scripts/measure-narration.ts                     # split on the pauses, measure
npx tsx scripts/record-demo.ts                           # re-record, held to the voice
npx tsx scripts/convert-recordings.sh                    # to H.264
npx tsx scripts/mux-narration.ts                         # lay the audio on
```

The order matters. Narration has to be **measured before the film is recorded**,
because the audio decides how long each beat holds on screen — an estimate from
word count is only the fallback for lines nobody has read yet. Getting that backwards
is what makes a voiceover drift out of step with the picture.

Two consequences worth knowing:

- **A partly-narrated film works.** Any line without audio falls back to its
  word-count estimate, so beats can be recorded one at a time.
- **Beat clips need their own pass.** A passage's offset in the film is not its offset
  in the standalone clip, so `--beats` records its own timings and the muxer refuses
  to mix the two rather than putting words under the wrong screen.

There is nothing on screen to keep in step with the voice, which is the other reason
the on-screen text went: one script, in one place, and no chance of what is written
disagreeing with what is said.

## Format

Recorded at 1920×1080. Playwright writes `.webm`; `scripts/convert-recordings.sh`
produces H.264 `.mp4` alongside it for playback anywhere.

```bash
bash scripts/convert-recordings.sh
```
